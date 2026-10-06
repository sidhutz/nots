import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { extname, basename } from 'node:path';
import { openSupabaseStore } from './supabase-store.mjs';
import { requireConfig } from './config.mjs';

const config = requireConfig();
const { port, base, clientId, clientSecret, n8nWebhookUrl, n8nWebhookSecret } = config;
const secure = base.startsWith('https:');
const callback = base + '/auth/google/callback';
if (!config.supabaseUrl || !config.supabaseSecretKey) throw Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env.');
const store = openSupabaseStore({ url: config.supabaseUrl, secretKey: config.supabaseSecretKey });

const random = () => randomBytes(32).toString('base64url');
const randomHex = size => randomBytes(size).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
const assets = new Map([
  ['/', ['text/html; charset=utf-8', readFileSync(new URL('./public/index.html', import.meta.url))]],
  ['/dashboard', ['text/html; charset=utf-8', readFileSync(new URL('./public/dashboard.html', import.meta.url))]],
  ['/privacy', ['text/html; charset=utf-8', readFileSync(new URL('./public/privacy.html', import.meta.url))]],
  ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('./public/style.css', import.meta.url))]],
  ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('./public/app.js', import.meta.url))]],
]);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').map(value => value.trim().split('=')).filter(parts => parts.length === 2));
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sanitizeText(value, max = 120) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function sanitizeFilename(value) {
  const safe = basename(String(value || 'note')).replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  return safe || 'note.bin';
}

function sameOrigin(req) {
  return !req.headers.origin || req.headers.origin === base;
}

async function getSessionUser(req) {
  const token = req.cookies.sid;
  if (!token) return null;
  return store.getSessionUser(hash(token));
}

async function requireUser(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    json(res, 401, { error: 'Sign in required' });
    return null;
  }
  return user;
}

async function googleJSON(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('Google request rejected');
  return response.json();
}

async function notifyN8n(eventType, data) {
  if (!n8nWebhookUrl) return;
  try {
    const response = await fetch(n8nWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(n8nWebhookSecret ? { 'X-Webhook-Secret': n8nWebhookSecret } : {}),
      },
      body: JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        ...data,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`n8n webhook error (${eventType}): HTTP ${response.status} ${response.statusText}`, body ? `— ${body.slice(0, 200)}` : '');
    } else {
      console.log(`n8n webhook notified: ${eventType} (HTTP ${response.status})`);
    }
  } catch (error) {
    console.error(`n8n webhook failed (${eventType}):`, error.message);
  }
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxBytes = 64 * 1024) {
  const body = await readBody(req, maxBytes);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

async function parseMultipart(req, maxBytes = 10 * 1024 * 1024) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Error('Missing form boundary');
  const boundaryToken = match[1] || match[2];
  const firstBoundary = Buffer.from(`--${boundaryToken}`);
  const separator = Buffer.from(`\r\n--${boundaryToken}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const terminal = Buffer.from('--');
  const body = await readBody(req, maxBytes);
  const fields = {};
  const files = {};
  let position = 0;
  while (true) {
    const start = body.indexOf(firstBoundary, position);
    if (start === -1) break;
    position = start + firstBoundary.length;
    if (body.subarray(position, position + 2).equals(terminal)) break;
    if (body.subarray(position, position + 2).toString('latin1') === '\r\n') position += 2;
    const headerEnd = body.indexOf(headerSeparator, position);
    if (headerEnd === -1) throw Error('Invalid multipart headers');
    const headers = body.subarray(position, headerEnd).toString('utf8');
    const disposition = headers.match(/name="([^"]+)"(?:; filename="([^"]*)")?/i);
    if (!disposition) throw Error('Missing multipart field name');
    const fieldName = disposition[1];
    const fileName = disposition[2];
    const typeMatch = headers.match(/content-type:\s*([^\r\n]+)/i);
    const dataStart = headerEnd + headerSeparator.length;
    const nextBoundary = body.indexOf(separator, dataStart);
    if (nextBoundary === -1) throw Error('Invalid multipart ending');
    const value = body.subarray(dataStart, nextBoundary);
    position = nextBoundary + 2;
    if (fileName !== undefined) {
      files[fieldName] = {
        filename: fileName,
        contentType: (typeMatch?.[1] || 'application/octet-stream').trim(),
        data: value,
      };
    } else {
      fields[fieldName] = value.toString('utf8');
    }
  }
  return { fields, files };
}

function formatUser(user) {
  return {
    id: user.id,
    full_name: user.full_name,
    contact_email: user.contact_email,
    role: user.role,
    profile_completed: Boolean(user.profile_completed),
    google_email: user.google_email,
    google_name: user.google_name,
    picture: user.picture,
    email_verified: Boolean(user.email_verified),
    created_at: user.created_at,
    last_login: user.last_login,
  };
}

function noteJson(note) {
  return {
    ...note,
    downloadUrl: `/api/notes/${note.id}/download`,
    previewUrl: `/api/notes/${note.id}/preview`,
  };
}

function audit(userId, eventType, details = {}) {
  store.logActivity(userId, eventType, details).catch(error => console.error('Activity log failed:', error.message));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://*.googleusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  req.cookies = parseCookies(req.headers.cookie || '');

  try {
    const url = new URL(req.url, base);

    if (req.method === 'GET' && url.pathname === '/auth/google') {
      if (!clientId || !clientSecret) return redirect(res, '/?error=setup');
      await store.cleanup();
      const state = random();
      const verifier = random();
      await store.createOAuthState(hash(state), verifier, Date.now() + 600000);
      res.setHeader('Set-Cookie', cookie('oauth_state', state, 600));
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      return redirect(res, auth.href);
    }

    if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
      res.setHeader('Set-Cookie', cookie('oauth_state', '', 0));
      const state = url.searchParams.get('state');
      if (!state || !same(state, req.cookies.oauth_state)) return redirect(res, '/?error=state');
      const flow = await store.consumeOAuthState(hash(state));
      if (!flow || flow.expires_at <= Date.now()) return redirect(res, '/?error=state');
      if (url.searchParams.has('error')) return redirect(res, '/?error=cancelled');
      const code = url.searchParams.get('code');
      if (!code) return redirect(res, '/?error=login');
      const tokens = await googleJSON('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: callback,
          grant_type: 'authorization_code',
          code,
          code_verifier: flow.verifier,
        }),
      });
      if (typeof tokens.access_token !== 'string') throw Error('Missing token');
      const profile = await googleJSON('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (typeof profile.sub !== 'string' || typeof profile.email !== 'string' || profile.email_verified !== true) return redirect(res, '/?error=unverified');
      const user = await store.upsert(profile);
      if (req.cookies.sid) await store.deleteSession(hash(req.cookies.sid));
      const sid = random();
      await store.createSession(hash(sid), user.id, Date.now() + 604800000);
      audit(user.id, 'google_login');
      res.setHeader('Set-Cookie', [cookie('oauth_state', '', 0), cookie('sid', sid, 604800)]);
      // Notify n8n automation (fire-and-forget, don't block login)
      notifyN8n('google_login', {
        user: {
          id: user.id,
          google_email: profile.email,
          google_name: profile.name || '',
          picture: profile.picture || null,
          email_verified: profile.email_verified,
          full_name: user.full_name || profile.name || '',
          contact_email: user.contact_email || profile.email,
          role: user.role || 'Student',
          profile_completed: Boolean(user.profile_completed),
        },
      }).catch(err => console.error('n8n login notification error:', err.message));
      return redirect(res, '/dashboard');
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = await requireUser(req, res);
      if (!user) return;
      audit(user.id, 'profile_viewed');
      return json(res, 200, { user: formatUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const fullName = sanitizeText(body.fullName, 120);
      const contactEmail = sanitizeText(body.contactEmail, 160).toLowerCase();
      if (fullName.length < 2) return json(res, 400, { error: 'Full name must be at least 2 characters.' });
      if (!isValidEmail(contactEmail)) return json(res, 400, { error: 'Enter a valid email address.' });
      const updated = await store.updateStudentProfile(user.id, { fullName, contactEmail });
      audit(user.id, 'profile_updated');
      return json(res, 200, { user: formatUser(updated) });
    }

    if (req.method === 'GET' && url.pathname === '/api/notes') {
      const user = await requireUser(req, res);
      if (!user) return;
      audit(user.id, 'notes_viewed');
      return json(res, 200, { notes: (await store.listNotesByUser(user.id)).map(noteJson) });
    }

    if (req.method === 'POST' && url.pathname === '/api/notes/upload') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = await requireUser(req, res);
      if (!user) return;
      if (!user.profile_completed) return json(res, 400, { error: 'Save your student profile before uploading notes.' });
      const { fields, files } = await parseMultipart(req);
      const uploaded = files.noteFile;
      if (!uploaded || !uploaded.data?.length) return json(res, 400, { error: 'Choose a note file to upload.' });
      const originalName = sanitizeFilename(uploaded.filename);
      const title = sanitizeText(fields.title || originalName.replace(/\.[^.]+$/, ''), 120) || 'Untitled note';
      const extension = extname(originalName).slice(0, 20);
      const relativeName = `${hash(user.id).slice(0, 32)}/${Date.now()}-${randomHex(6)}${extension}`;
      await store.uploadNote(relativeName, uploaded.data, uploaded.contentType);
      let note;
      try { note = await store.createNote({
        userId: user.id,
        title,
        originalName,
        storedName: relativeName,
        mimeType: uploaded.contentType,
        sizeBytes: uploaded.data.length,
      }); } catch (error) { await store.deleteNoteFile(relativeName).catch(() => {}); throw error; }
      audit(user.id, 'note_uploaded', { noteId: note.id, sizeBytes: uploaded.data.length });
      return json(res, 201, { note: noteJson(note) });
    }

    if (req.method === 'GET' && url.pathname === '/api/feed') {
      const user = await requireUser(req, res);
      if (!user) return;
      audit(user.id, 'public_feed_viewed');
      return json(res, 200, { posts: await store.listPublicFeed(user.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/posts') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = await requireUser(req, res);
      if (!user) return;
      if (!user.profile_completed) return json(res, 400, { error: 'Complete your student profile before sharing a public note.' });
      const body = await readJson(req, 64 * 1024);
      const title = sanitizeText(body.title, 120);
      const content = String(body.content || '').replace(/\r\n/g, '\n').trim().slice(0, 10000);
      if (!title) return json(res, 400, { error: 'Add a title to your public note.' });
      if (!content) return json(res, 400, { error: 'Write something before publishing.' });
      const post = await store.createPublicPost({ userId: user.id, title, content });
      audit(user.id, 'public_post_created', { postId: post.id });
      return json(res, 201, { post });
    }

    const postMatch = url.pathname.match(/^\/api\/posts\/(\d+)(?:\/(likes|comments|reposts))?$/);
    if (postMatch) {
      const postId = Number(postMatch[1]);
      const action = postMatch[2] || 'post';
      const user = await requireUser(req, res);
      if (!user) return;
      const post = await store.getPublicPostById(postId);
      if (!post) return json(res, 404, { error: 'Public note not found.' });

      if (action === 'post' && req.method === 'DELETE') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
        if (String(post.author_id) !== String(user.id)) return json(res, 403, { error: 'You can only delete your own public notes.' });
        await store.deletePublicPost(postId, user.id);
        audit(user.id, 'public_post_deleted', { postId });
        return json(res, 200, { ok: true });
      }

      if (action === 'likes') {
        if (req.method === 'GET') return json(res, 200, { likes: await store.listPostLikes(postId) });
        if (req.method === 'POST' || req.method === 'DELETE') {
          if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
          if (req.method === 'POST') {
            await store.likePublicPost(postId, user.id);
            audit(user.id, 'public_post_liked', { postId });
          } else {
            await store.unlikePublicPost(postId, user.id);
            audit(user.id, 'public_post_unliked', { postId });
          }
          return json(res, 200, { ok: true });
        }
      }

      if (action === 'comments') {
        if (req.method === 'GET') return json(res, 200, { comments: await store.listPostComments(postId) });
        if (req.method === 'POST') {
          if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
          if (!user.profile_completed) return json(res, 400, { error: 'Complete your student profile before commenting.' });
          const body = await readJson(req, 8 * 1024);
          const content = String(body.content || '').trim().slice(0, 1000);
          if (!content) return json(res, 400, { error: 'Write a comment first.' });
          const comment = await store.createPostComment({ postId, userId: user.id, content });
          audit(user.id, 'public_post_commented', { postId, commentId: comment.id });
          return json(res, 201, { comment });
        }
      }

      if (action === 'reposts') {
        if (req.method === 'GET') return json(res, 200, { reposts: await store.listPostReposts(postId) });
        if (req.method === 'POST' || req.method === 'DELETE') {
          if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
          if (req.method === 'POST') {
            await store.repostPublicPost(postId, user.id);
            audit(user.id, 'public_post_reposted', { postId });
          } else {
            await store.unrepostPublicPost(postId, user.id);
            audit(user.id, 'public_post_unreposted', { postId });
          }
          return json(res, 200, { ok: true });
        }
      }
    }

    const noteMatch = url.pathname.match(/^\/api\/notes\/(\d+)(?:\/(download|preview))?$/);
    if (noteMatch) {
      const noteId = Number(noteMatch[1]);
      const action = noteMatch[2] || 'delete';
      const user = await requireUser(req, res);
      if (!user) return;
      const note = await store.getNoteByIdForUser(noteId, user.id);
      if (!note) return json(res, 404, { error: 'Note not found.' });
      if ((action === 'download' || action === 'preview') && req.method === 'GET') {
        if (action === 'preview' && note.mimeType !== 'application/pdf' && !/^image\/(png|jpeg|gif|webp)$/.test(note.mimeType || '')) {
          return json(res, 415, { error: 'Preview is available for PDF and common image files.' });
        }
        let file;
        try { file = await store.downloadNote(note.storedName); } catch { return json(res, 404, { error: 'Stored file not found.' }); }
        audit(user.id, action === 'preview' ? 'note_previewed' : 'note_downloaded', { noteId: note.id });
        res.writeHead(200, {
          'Content-Type': note.mimeType || 'application/octet-stream',
          'Content-Length': String(file.length),
          'Content-Disposition': `${action === 'preview' ? 'inline' : 'attachment'}; filename="${sanitizeFilename(note.originalName).replace(/"/g, '')}"`,
          ...(action === 'preview' ? {
            'X-Frame-Options': 'SAMEORIGIN',
            'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'; object-src 'none'",
          } : {}),
        });
        return res.end(file);
      }
      if (action === 'delete' && req.method === 'DELETE') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
        await store.deleteNoteFile(note.storedName);
        await store.deleteNoteByIdForUser(noteId, user.id);
        audit(user.id, 'note_deleted', { noteId });
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/text-notes') {
      const user = await requireUser(req, res);
      if (!user) return;
      audit(user.id, 'text_notes_viewed');
      return json(res, 200, { textNotes: await store.listTextNotesByUser(user.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/text-notes') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = await requireUser(req, res);
      if (!user) return;
      if (!user.profile_completed) return json(res, 400, { error: 'Save your student profile before adding personal notes.' });
      const body = await readJson(req);
      const title = sanitizeText(body.title, 120);
      const content = String(body.content || '').trim().slice(0, 10000);
      if (!title) return json(res, 400, { error: 'Title is required for personal note.' });
      if (!content) return json(res, 400, { error: 'Content is required for personal note.' });
      const textNote = await store.createTextNote({ userId: user.id, title, content });
      audit(user.id, 'text_note_created', { noteId: textNote.id });
      return json(res, 201, { textNote });
    }

    const textNoteMatch = url.pathname.match(/^\/api\/text-notes\/(\d+)$/);
    if (textNoteMatch) {
      const noteId = Number(textNoteMatch[1]);
      const user = await requireUser(req, res);
      if (!user) return;
      const existing = await store.getTextNoteByIdForUser(noteId, user.id);
      if (!existing) return json(res, 404, { error: 'Personal note not found.' });
      if (req.method === 'PUT' || req.method === 'PATCH') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
        const body = await readJson(req);
        const title = sanitizeText(body.title || existing.title, 120);
        const content = body.content !== undefined ? String(body.content).trim().slice(0, 10000) : existing.content;
        if (!title) return json(res, 400, { error: 'Title is required.' });
        if (!content) return json(res, 400, { error: 'Content is required.' });
        const updated = await store.updateTextNoteForUser(noteId, user.id, { title, content });
        audit(user.id, 'text_note_updated', { noteId });
        return json(res, 200, { textNote: updated });
      }
      if (req.method === 'DELETE') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
        await store.deleteTextNoteByIdForUser(noteId, user.id);
        audit(user.id, 'text_note_deleted', { noteId });
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/todos') {
      const user = await requireUser(req, res);
      if (!user) return;
      audit(user.id, 'todos_viewed');
      return json(res, 200, { todos: await store.listTodosByUser(user.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/todos') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = await requireUser(req, res);
      if (!user) return;
      if (!user.profile_completed) return json(res, 400, { error: 'Save your student profile before adding todos.' });
      const body = await readJson(req);
      const text = sanitizeText(body.text, 200);
      const dueAt = body.dueAt ? new Date(body.dueAt) : null;
      if (!text) return json(res, 400, { error: 'Todo text is required.' });
      if (body.dueAt && Number.isNaN(dueAt.getTime())) return json(res, 400, { error: 'Choose a valid reminder date and time.' });
      const todo = await store.createTodo({ userId: user.id, text, dueAt: dueAt?.toISOString() || null });
      audit(user.id, 'todo_created', { todoId: todo.id });
      return json(res, 201, { todo });
    }

    const todoMatch = url.pathname.match(/^\/api\/todos\/(\d+)$/);
    if (todoMatch) {
      const todoId = Number(todoMatch[1]);
      const user = await requireUser(req, res);
      if (!user) return;
      const existing = await store.getTodoByIdForUser(todoId, user.id);
      if (!existing) return json(res, 404, { error: 'Todo not found.' });
      if (req.method === 'PATCH' || req.method === 'PUT') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
        const body = await readJson(req);
        const completed = body.completed !== undefined ? Boolean(body.completed) : existing.completed;
        let dueAt = existing.dueAt;
        if (body.dueAt !== undefined) {
          if (body.dueAt === null || body.dueAt === '') {
            dueAt = null;
          } else {
            const parsedDueAt = new Date(body.dueAt);
            if (Number.isNaN(parsedDueAt.getTime())) return json(res, 400, { error: 'Choose a valid reminder date and time.' });
            dueAt = parsedDueAt.toISOString();
          }
        }
        const updated = await store.updateTodoForUser(todoId, user.id, { completed, dueAt });
        audit(user.id, 'todo_updated', { todoId, completed });
        return json(res, 200, { todo: updated });
      }
      if (req.method === 'DELETE') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
        await store.deleteTodoForUser(todoId, user.id);
        audit(user.id, 'todo_deleted', { todoId });
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/account/export') {
      const user = await requireUser(req, res);
      if (!user) return;
      audit(user.id, 'account_exported');
      return json(res, 200, {
        exportedAt: new Date().toISOString(),
        profile: formatUser(user),
        uploadedNotes: await store.listNotesByUser(user.id),
        writtenNotes: await store.listTextNotesByUser(user.id),
        tasks: await store.listTodosByUser(user.id),
        activity: await store.listActivityByUser(user.id),
        publicCommunity: await store.listPublicDataByUser(user.id),
      });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/account') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      if (body.confirmation !== 'DELETE') return json(res, 400, { error: 'Type DELETE to confirm account removal.' });
      await store.deleteAccount(user.id);
      res.setHeader('Set-Cookie', cookie('sid', '', 0));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = await getSessionUser(req);
      if (req.cookies.sid) await store.deleteSession(hash(req.cookies.sid));
      if (user) audit(user.id, 'logout');
      res.setHeader('Set-Cookie', cookie('sid', '', 0));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && assets.has(url.pathname)) {
      if (url.pathname === '/dashboard') {
        const user = await getSessionUser(req);
        if (!user) return redirect(res, '/');
        audit(user.id, 'dashboard_viewed');
      }
      const [type, body] = assets.get(url.pathname);
      res.writeHead(200, { 'Content-Type': type });
      return res.end(body);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const known = {
      'Body too large': ['The uploaded file is too large. Keep it under 10 MB.', 413],
      'Missing form boundary': ['Upload the file using the provided form.', 400],
      'Invalid multipart headers': ['The upload format was invalid.', 400],
      'Missing multipart field name': ['The upload payload was invalid.', 400],
      'Invalid multipart ending': ['The upload payload was incomplete.', 400],
    };
    if (known[error.message] && req.url.startsWith('/api/')) {
      const [message, status] = known[error.message];
      return json(res, status, { error: message });
    }
    if (error instanceof SyntaxError && req.url.startsWith('/api/')) return json(res, 400, { error: 'Invalid request body.' });
    console.error('Request failed:', error.name);
    if (!res.headersSent) {
      if (req.url.startsWith('/api/')) return json(res, 500, { error: 'Something went wrong. Please try again.' });
      return redirect(res, '/?error=login');
    }
    res.end();
  }
});

setInterval(() => store.cleanup().catch(error => console.error('Supabase cleanup failed:', error.message)), 60000).unref();
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? 'Port is busy. Stop the OLD website terminal with Ctrl+C, then start this version again.'
    : `Server failed (${error.code || 'unknown'}). Check the port and permissions.`);
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  console.log('Nest Student Notes v1.2 - Google credentials loaded (values hidden).');
  console.log(`Website ready: ${base}`);
  console.log(`Google callback: ${callback}`);
  console.log('Database and private files: Supabase');
  console.log('n8n webhook:', n8nWebhookUrl ? `Connected → ${n8nWebhookUrl}` : 'Not configured (N8N_LOGIN_WEBHOOK_URL missing in .env)');
});
