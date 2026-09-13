import http from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { dirname, extname, basename, join, resolve } from 'node:path';
import { openStore } from './db.mjs';
import { requireConfig } from './config.mjs';

const config = requireConfig();
const { port, base, clientId, clientSecret } = config;
const secure = base.startsWith('https:');
const callback = base + '/auth/google/callback';
const store = openStore(config.dbPath);
const db = store.db;
const uploadRoot = resolve(dirname(config.dbPath), 'uploads');
mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });

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

function getSessionUser(req) {
  const token = req.cookies.sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id FROM users u
    JOIN sessions s ON s.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token), Date.now());
  return row ? store.getUserById(row.id) : null;
}

function requireUser(req, res) {
  const user = getSessionUser(req);
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

function noteFilePath(note) {
  const fullPath = resolve(uploadRoot, note.storedName);
  if (!fullPath.startsWith(uploadRoot)) throw Error('Unsafe note path');
  return fullPath;
}

function noteJson(note) {
  return {
    ...note,
    downloadUrl: `/api/notes/${note.id}/download`,
  };
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
      store.cleanup();
      if (req.cookies.oauth_state) db.prepare('DELETE FROM oauth_states WHERE token_hash=?').run(hash(req.cookies.oauth_state));
      const state = random();
      const verifier = random();
      db.prepare('INSERT INTO oauth_states VALUES(?,?,?)').run(hash(state), verifier, Date.now() + 600000);
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
      const flow = db.prepare('DELETE FROM oauth_states WHERE token_hash=? RETURNING *').get(hash(state));
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
      const user = store.upsert(profile);
      if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.cookies.sid));
      const sid = random();
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(sid), user.id, Date.now() + 604800000);
      res.setHeader('Set-Cookie', [cookie('oauth_state', '', 0), cookie('sid', sid, 604800)]);
      return redirect(res, '/dashboard');
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { user: formatUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/profile') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readJson(req);
      const fullName = sanitizeText(body.fullName, 120);
      const contactEmail = sanitizeText(body.contactEmail, 160).toLowerCase();
      if (fullName.length < 2) return json(res, 400, { error: 'Full name must be at least 2 characters.' });
      if (!isValidEmail(contactEmail)) return json(res, 400, { error: 'Enter a valid email address.' });
      const updated = store.updateStudentProfile(user.id, { fullName, contactEmail });
      return json(res, 200, { user: formatUser(updated) });
    }

    if (req.method === 'GET' && url.pathname === '/api/notes') {
      const user = requireUser(req, res);
      if (!user) return;
      return json(res, 200, { notes: store.listNotesByUser(user.id).map(noteJson) });
    }

    if (req.method === 'POST' && url.pathname === '/api/notes/upload') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      const user = requireUser(req, res);
      if (!user) return;
      if (!user.profile_completed) return json(res, 400, { error: 'Save your student profile before uploading notes.' });
      const { fields, files } = await parseMultipart(req);
      const uploaded = files.noteFile;
      if (!uploaded || !uploaded.data?.length) return json(res, 400, { error: 'Choose a note file to upload.' });
      const originalName = sanitizeFilename(uploaded.filename);
      const title = sanitizeText(fields.title || originalName.replace(/\.[^.]+$/, ''), 120) || 'Untitled note';
      const extension = extname(originalName).slice(0, 20);
      const relativeName = join(String(user.id), `${Date.now()}-${randomHex(6)}${extension}`);
      const fullPath = resolve(uploadRoot, relativeName);
      mkdirSync(dirname(fullPath), { recursive: true, mode: 0o700 });
      writeFileSync(fullPath, uploaded.data);
      const note = store.createNote({
        userId: user.id,
        title,
        originalName,
        storedName: relativeName,
        mimeType: uploaded.contentType,
        sizeBytes: uploaded.data.length,
      });
      return json(res, 201, { note: noteJson(note) });
    }

    const noteMatch = url.pathname.match(/^\/api\/notes\/(\d+)(?:\/(download))?$/);
    if (noteMatch) {
      const noteId = Number(noteMatch[1]);
      const action = noteMatch[2] || 'delete';
      const user = requireUser(req, res);
      if (!user) return;
      const note = store.getNoteByIdForUser(noteId, user.id);
      if (!note) return json(res, 404, { error: 'Note not found.' });
      if (action === 'download' && req.method === 'GET') {
        const fullPath = noteFilePath(note);
        if (!existsSync(fullPath)) return json(res, 404, { error: 'Stored file not found.' });
        const file = readFileSync(fullPath);
        res.writeHead(200, {
          'Content-Type': note.mimeType || 'application/octet-stream',
          'Content-Length': String(file.length),
          'Content-Disposition': `attachment; filename="${sanitizeFilename(note.originalName).replace(/"/g, '')}"`,
        });
        return res.end(file);
      }
      if (action === 'delete' && req.method === 'DELETE') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
        const fullPath = noteFilePath(note);
        if (existsSync(fullPath)) unlinkSync(fullPath);
        store.deleteNoteByIdForUser(noteId, user.id);
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid request origin' });
      if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.cookies.sid));
      res.setHeader('Set-Cookie', cookie('sid', '', 0));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && assets.has(url.pathname)) {
      if (url.pathname === '/dashboard' && !getSessionUser(req)) return redirect(res, '/');
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

setInterval(() => store.cleanup(), 60000).unref();
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? 'Port is busy. Stop the OLD website terminal with Ctrl+C, then start this version again.'
    : `Server failed (${error.code || 'unknown'}). Check the port and permissions.`);
  process.exit(1);
});
server.listen(port, () => {
  console.log('Nest Student Notes v1.2 - Google credentials loaded (values hidden).');
  console.log(`Website ready: ${base}`);
  console.log(`Google callback: ${callback}`);
  console.log('Database:', config.dbPath);
  console.log('Private files:', uploadRoot);
});
