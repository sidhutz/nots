import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readConfig } from './config.mjs';

const apply = process.argv.includes('--apply');
const config = readConfig();
if (config.errors.length) throw Error(config.errors.join('\n'));
if (!config.supabaseUrl || !config.supabaseSecretKey) throw Error('Supabase server settings are missing from .env.');
if (!existsSync(config.dbPath)) throw Error('Local SQLite database was not found.');

const sqlite = new DatabaseSync(config.dbPath, { readOnly: true });
const users = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
const notes = sqlite.prepare('SELECT * FROM notes ORDER BY id').all();
const textNotes = sqlite.prepare('SELECT * FROM text_notes ORDER BY id').all();
const todos = sqlite.prepare('SELECT * FROM todos ORDER BY id').all();
const uploadsRoot = resolve(dirname(config.dbPath), 'uploads');
const items = { users: users.length, uploadedFiles: notes.length, personalNotes: textNotes.length, todos: todos.length };
console.log(`${apply ? 'Migration preview' : 'Dry run (no changes made)'}: ${JSON.stringify(items)}`);
if (!apply) {
  console.log('Review the counts, then run: node migrate-to-supabase.mjs --apply');
  sqlite.close();
  process.exit(0);
}

const root = config.supabaseUrl.replace(/\/$/, '');
const headers = { apikey: config.supabaseSecretKey };
async function request(path, options = {}) {
  const response = await fetch(`${root}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`Supabase migration request failed (${response.status}). No local data was removed.`);
  return response.status === 204 ? null : response.json().catch(() => null);
}
async function count(table) {
  const response = await fetch(`${root}/rest/v1/${table}?select=id&limit=1`, { headers: { ...headers, Prefer: 'count=exact', Range: '0-0' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`Supabase table ${table} is unavailable; apply supabase-schema.sql first.`);
  const match = response.headers.get('content-range')?.match(/\/(\d+)$/);
  return Number(match?.[1] || 0);
}

for (const table of ['users', 'notes', 'text_notes', 'todos']) {
  if (await count(table)) throw Error(`Supabase ${table} table already contains data. Migration stopped to avoid merging records unexpectedly.`);
}

for (const user of users) {
  await request('/rest/v1/users?on_conflict=google_id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: user.google_id, google_id: user.google_id, email: user.email, name: user.name || '',
      picture: user.picture || null, email_verified: Boolean(user.email_verified),
      created_at: user.created_at, last_login: user.last_login,
      full_name: user.full_name || user.name || '', contact_email: user.contact_email || user.email,
      role: user.role || 'Student', profile_completed: Boolean(user.profile_completed),
    }),
  });
}

for (const note of notes) {
  const user = users.find(item => item.id === note.user_id);
  if (!user) throw Error('A note has no matching local account; migration stopped.');
  const source = resolve(uploadsRoot, note.stored_name);
  if (!source.startsWith(`${uploadsRoot}${process.platform === 'win32' ? '\\' : '/'}`) || !existsSync(source)) {
    throw Error('A local note file is missing or has an unsafe path; migration stopped.');
  }
  const filename = basename(note.stored_name);
  const prefix = createHash('sha256').update(user.google_id).digest('hex').slice(0, 32);
  const storedName = `${prefix}/${filename}`;
  const encoded = storedName.split('/').map(encodeURIComponent).join('/');
  const bytes = readFileSync(source);
  await request(`/storage/v1/object/student-notes/${encoded}`, {
    method: 'POST',
    headers: { 'Content-Type': note.mime_type || 'application/octet-stream', 'x-upsert': 'true' },
    body: bytes,
  });
  await request('/rest/v1/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.google_id, title: note.title, original_name: note.original_name,
      stored_name: storedName, mime_type: note.mime_type || 'application/octet-stream',
      size_bytes: note.size_bytes, created_at: note.created_at,
    }),
  });
}

for (const note of textNotes) {
  const user = users.find(item => item.id === note.user_id);
  if (!user) throw Error('A personal note has no matching local account; migration stopped.');
  await request('/rest/v1/text_notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: user.google_id, title: note.title, content: note.content, created_at: note.created_at, updated_at: note.updated_at }),
  });
}

for (const todo of todos) {
  const user = users.find(item => item.id === todo.user_id);
  if (!user) throw Error('A todo has no matching local account; migration stopped.');
  await request('/rest/v1/todos', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: user.google_id, text: todo.text, completed: Boolean(todo.completed), created_at: todo.created_at }),
  });
}

sqlite.close();
console.log(`Migration complete: ${JSON.stringify(items)}. The original SQLite database and uploads were kept as a backup.`);
