const BUCKET = 'student-notes';

export function openSupabaseStore({ url, secretKey }) {
  const root = url.replace(/\/$/, '');
  const headers = { apikey: secretKey };

  async function call(path, { method = 'GET', body, prefer, contentType } = {}) {
    const response = await fetch(`${root}${path}`, {
      method,
      headers: {
        ...headers,
        ...(contentType ? { 'Content-Type': contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      ...(body !== undefined ? { body: contentType ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error(`Supabase request failed (${response.status})`);
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    return type.includes('application/json') ? response.json() : Buffer.from(await response.arrayBuffer());
  }

  const filter = value => encodeURIComponent(String(value));
  const rows = (table, query = '') => call(`/rest/v1/${table}?${query}`);
  const write = (table, method, query, value, prefer = 'return=representation') =>
    call(`/rest/v1/${table}?${query}`, { method, body: value, prefer });
  const one = async (table, query) => (await rows(table, `${query}&limit=1`))[0] || null;
  const viewUser = row => row && ({
    ...row,
    google_email: row.email,
    google_name: row.name,
    profile_completed: Boolean(row.profile_completed),
    email_verified: Boolean(row.email_verified),
  });
  const noteView = row => row && ({
    id: row.id,
    title: row.title,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
  });

  return {
    async upsert(profile) {
      const result = await write('users', 'POST', 'on_conflict=google_id', {
        id: profile.sub,
        google_id: profile.sub,
        email: profile.email,
        name: profile.name || '',
        picture: profile.picture || null,
        email_verified: Boolean(profile.email_verified),
        last_login: new Date().toISOString(),
      }, 'resolution=merge-duplicates,return=representation');
      return viewUser(result[0]);
    },
    async getUserById(userId) {
      return viewUser(await one('users', `select=*&id=eq.${filter(userId)}`));
    },
    async updateStudentProfile(userId, { fullName, contactEmail }) {
      const result = await write('users', 'PATCH', `id=eq.${filter(userId)}`, {
        full_name: fullName, contact_email: contactEmail, role: 'Student', profile_completed: true,
      });
      return viewUser(result[0] || null);
    },
    async createOAuthState(tokenHash, verifier, expiresAt) {
      await write('oauth_states', 'POST', '', { token_hash: tokenHash, verifier, expires_at: expiresAt });
    },
    async consumeOAuthState(tokenHash) {
      const removed = await write('oauth_states', 'DELETE', `token_hash=eq.${filter(tokenHash)}`, undefined, 'return=representation');
      return removed[0] || null;
    },
    async createSession(tokenHash, userId, expiresAt) {
      await write('sessions', 'POST', '', { token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
    },
    async deleteSession(tokenHash) {
      if (tokenHash) await write('sessions', 'DELETE', `token_hash=eq.${filter(tokenHash)}`, undefined, 'return=minimal');
    },
    async getSessionUser(tokenHash, now = Date.now()) {
      if (!tokenHash) return null;
      const session = await one('sessions', `select=user_id&token_hash=eq.${filter(tokenHash)}&expires_at=gt.${now}`);
      return session ? this.getUserById(session.user_id) : null;
    },
    async createNote({ userId, title, originalName, storedName, mimeType, sizeBytes }) {
      const result = await write('notes', 'POST', '', {
        user_id: userId, title, original_name: originalName, stored_name: storedName,
        mime_type: mimeType || 'application/octet-stream', size_bytes: sizeBytes,
      });
      return noteView(result[0]);
    },
    async listNotesByUser(userId) {
      return (await rows('notes', `select=*&user_id=eq.${filter(userId)}&order=id.desc`)).map(noteView);
    },
    async getNoteByIdForUser(noteId, userId) {
      const row = await one('notes', `select=*&id=eq.${filter(noteId)}&user_id=eq.${filter(userId)}`);
      return row && { ...noteView(row), userId: row.user_id, storedName: row.stored_name };
    },
    async deleteNoteByIdForUser(noteId, userId) {
      const result = await rows('notes', `select=id&id=eq.${filter(noteId)}&user_id=eq.${filter(userId)}`);
      if (!result.length) return false;
      await write('notes', 'DELETE', `id=eq.${filter(noteId)}&user_id=eq.${filter(userId)}`, undefined, 'return=minimal');
      return true;
    },
    async uploadNote(path, data, mimeType) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      await call(`/storage/v1/object/${BUCKET}/${encoded}`, {
        method: 'POST', body: data, contentType: mimeType || 'application/octet-stream',
        prefer: 'resolution=ignore-duplicates',
      });
    },
    async downloadNote(path) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      return call(`/storage/v1/object/${BUCKET}/${encoded}`);
    },
    async deleteNoteFile(path) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      await call(`/storage/v1/object/${BUCKET}/${encoded}`, { method: 'DELETE' });
    },
    async createTextNote({ userId, title, content }) {
      const result = await write('text_notes', 'POST', '', { user_id: userId, title, content });
      const row = result[0];
      return { id: row.id, title: row.title, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at };
    },
    async listTextNotesByUser(userId) {
      return (await rows('text_notes', `select=*&user_id=eq.${filter(userId)}&order=id.desc`)).map(row => ({ id: row.id, title: row.title, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at }));
    },
    async getTextNoteByIdForUser(noteId, userId) {
      const row = await one('text_notes', `select=*&id=eq.${filter(noteId)}&user_id=eq.${filter(userId)}`);
      return row && { id: row.id, userId: row.user_id, title: row.title, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at };
    },
    async updateTextNoteForUser(noteId, userId, { title, content }) {
      await write('text_notes', 'PATCH', `id=eq.${filter(noteId)}&user_id=eq.${filter(userId)}`, { title, content, updated_at: new Date().toISOString() });
      return this.getTextNoteByIdForUser(noteId, userId);
    },
    async deleteTextNoteByIdForUser(noteId, userId) {
      await write('text_notes', 'DELETE', `id=eq.${filter(noteId)}&user_id=eq.${filter(userId)}`, undefined, 'return=minimal');
    },
    async createTodo({ userId, text }) {
      const result = await write('todos', 'POST', '', { user_id: userId, text });
      const row = result[0];
      return { id: row.id, text: row.text, completed: Boolean(row.completed), createdAt: row.created_at };
    },
    async listTodosByUser(userId) {
      return (await rows('todos', `select=*&user_id=eq.${filter(userId)}&order=id.desc`)).map(row => ({ id: row.id, text: row.text, completed: Boolean(row.completed), createdAt: row.created_at }));
    },
    async getTodoByIdForUser(todoId, userId) {
      const row = await one('todos', `select=*&id=eq.${filter(todoId)}&user_id=eq.${filter(userId)}`);
      return row && { id: row.id, userId: row.user_id, text: row.text, completed: Boolean(row.completed), createdAt: row.created_at };
    },
    async toggleTodoForUser(todoId, userId, completed) {
      await write('todos', 'PATCH', `id=eq.${filter(todoId)}&user_id=eq.${filter(userId)}`, { completed });
      return this.getTodoByIdForUser(todoId, userId);
    },
    async deleteTodoForUser(todoId, userId) {
      await write('todos', 'DELETE', `id=eq.${filter(todoId)}&user_id=eq.${filter(userId)}`, undefined, 'return=minimal');
    },
    async logActivity(userId, eventType, details = {}) {
      await write('activity_log', 'POST', '', { user_id: userId || null, event_type: eventType, details });
    },
    async cleanup() {
      const now = Date.now();
      await write('sessions', 'DELETE', `expires_at=lte.${now}`, undefined, 'return=minimal');
      await write('oauth_states', 'DELETE', `expires_at=lte.${now}`, undefined, 'return=minimal');
    },
  };
}
