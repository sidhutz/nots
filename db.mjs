import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function ensureUserColumns(db) {
  const columns = new Set(db.prepare(`PRAGMA table_info(users)`).all().map(column => column.name));
  const additions = [
    ['full_name', `ALTER TABLE users ADD COLUMN full_name TEXT`],
    ['contact_email', `ALTER TABLE users ADD COLUMN contact_email TEXT`],
    ['role', `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'Student'`],
    ['profile_completed', `ALTER TABLE users ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 0`],
  ];
  for (const [name, sql] of additions) {
    if (!columns.has(name)) db.exec(sql);
  }
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      google_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT,
      email_verified INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_login TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      token_hash TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS text_notes (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );`);
  ensureUserColumns(db);
  return {
    db,
    upsert(profile) {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO users (
          google_id, email, name, picture, email_verified, created_at, last_login,
          full_name, contact_email, role, profile_completed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Student', 0)
        ON CONFLICT(google_id) DO UPDATE SET
          email=excluded.email,
          name=excluded.name,
          picture=excluded.picture,
          email_verified=excluded.email_verified,
          last_login=excluded.last_login`).run(
        profile.sub,
        profile.email,
        profile.name || '',
        profile.picture || null,
        profile.email_verified ? 1 : 0,
        now,
        now,
        profile.name || '',
        profile.email,
      );
      return db.prepare('SELECT * FROM users WHERE google_id=?').get(profile.sub);
    },
    getUserById(userId) {
      return db.prepare(`SELECT
          id,
          google_id,
          email AS google_email,
          name AS google_name,
          picture,
          email_verified,
          created_at,
          last_login,
          COALESCE(NULLIF(full_name, ''), name) AS full_name,
          COALESCE(NULLIF(contact_email, ''), email) AS contact_email,
          role,
          profile_completed
        FROM users
        WHERE id=?`).get(userId) || null;
    },
    updateStudentProfile(userId, { fullName, contactEmail }) {
      db.prepare(`UPDATE users
        SET full_name=?, contact_email=?, role='Student', profile_completed=1
        WHERE id=?`).run(fullName, contactEmail, userId);
      return this.getUserById(userId);
    },
    createNote({ userId, title, originalName, storedName, mimeType, sizeBytes }) {
      const createdAt = new Date().toISOString();
      const result = db.prepare(`INSERT INTO notes
        (user_id, title, original_name, stored_name, mime_type, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          userId,
          title,
          originalName,
          storedName,
          mimeType || 'application/octet-stream',
          sizeBytes,
          createdAt,
        );
      return db.prepare(`SELECT id, title, original_name AS originalName, mime_type AS mimeType,
        size_bytes AS sizeBytes, created_at AS createdAt
        FROM notes WHERE id=?`).get(result.lastInsertRowid);
    },
    listNotesByUser(userId) {
      return db.prepare(`SELECT id, title, original_name AS originalName, mime_type AS mimeType,
        size_bytes AS sizeBytes, created_at AS createdAt
        FROM notes WHERE user_id=? ORDER BY id DESC`).all(userId);
    },
    getNoteByIdForUser(noteId, userId) {
      return db.prepare(`SELECT id, user_id AS userId, title,
        original_name AS originalName, stored_name AS storedName,
        mime_type AS mimeType, size_bytes AS sizeBytes, created_at AS createdAt
        FROM notes WHERE id=? AND user_id=?`).get(noteId, userId) || null;
    },
    deleteNoteByIdForUser(noteId, userId) {
      return db.prepare(`DELETE FROM notes WHERE id=? AND user_id=?`).run(noteId, userId).changes > 0;
    },
    createTextNote({ userId, title, content }) {
      const now = new Date().toISOString();
      const result = db.prepare(`INSERT INTO text_notes
        (user_id, title, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`).run(userId, title, content, now, now);
      return db.prepare(`SELECT id, title, content, created_at AS createdAt, updated_at AS updatedAt
        FROM text_notes WHERE id=?`).get(result.lastInsertRowid);
    },
    listTextNotesByUser(userId) {
      return db.prepare(`SELECT id, title, content, created_at AS createdAt, updated_at AS updatedAt
        FROM text_notes WHERE user_id=? ORDER BY id DESC`).all(userId);
    },
    getTextNoteByIdForUser(noteId, userId) {
      return db.prepare(`SELECT id, user_id AS userId, title, content, created_at AS createdAt, updated_at AS updatedAt
        FROM text_notes WHERE id=? AND user_id=?`).get(noteId, userId) || null;
    },
    updateTextNoteForUser(noteId, userId, { title, content }) {
      const now = new Date().toISOString();
      db.prepare(`UPDATE text_notes SET title=?, content=?, updated_at=? WHERE id=? AND user_id=?`).run(title, content, now, noteId, userId);
      return this.getTextNoteByIdForUser(noteId, userId);
    },
    deleteTextNoteByIdForUser(noteId, userId) {
      return db.prepare(`DELETE FROM text_notes WHERE id=? AND user_id=?`).run(noteId, userId).changes > 0;
    },
    createTodo({ userId, text }) {
      const now = new Date().toISOString();
      const result = db.prepare(`INSERT INTO todos
        (user_id, text, completed, created_at)
        VALUES (?, ?, 0, ?)`).run(userId, text, now);
      const row = db.prepare(`SELECT id, text, completed, created_at AS createdAt FROM todos WHERE id=?`).get(result.lastInsertRowid);
      return { ...row, completed: Boolean(row.completed) };
    },
    listTodosByUser(userId) {
      return db.prepare(`SELECT id, text, completed, created_at AS createdAt FROM todos WHERE user_id=? ORDER BY id DESC`).all(userId).map(row => ({ ...row, completed: Boolean(row.completed) }));
    },
    getTodoByIdForUser(todoId, userId) {
      const row = db.prepare(`SELECT id, user_id AS userId, text, completed, created_at AS createdAt FROM todos WHERE id=? AND user_id=?`).get(todoId, userId);
      return row ? { ...row, completed: Boolean(row.completed) } : null;
    },
    toggleTodoForUser(todoId, userId, completed) {
      db.prepare(`UPDATE todos SET completed=? WHERE id=? AND user_id=?`).run(completed ? 1 : 0, todoId, userId);
      return this.getTodoByIdForUser(todoId, userId);
    },
    deleteTodoForUser(todoId, userId) {
      return db.prepare(`DELETE FROM todos WHERE id=? AND user_id=?`).run(todoId, userId).changes > 0;
    },
    cleanup() {
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
      db.prepare('DELETE FROM oauth_states WHERE expires_at<=?').run(Date.now());
    },
  };
}
