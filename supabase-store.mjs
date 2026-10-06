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
    if (!response.ok) {
      if (response.status === 404) {
        const error = await response.json().catch(() => null);
        if (error?.code === 'PGRST205') throw Error('Community database setup is incomplete. Apply the public-community Supabase migration.');
      }
      throw Error(`Supabase request failed (${response.status})`);
    }
    if (response.status === 204) return null;
    const type = response.headers.get('content-type') || '';
    return type.includes('application/json') ? response.json() : Buffer.from(await response.arrayBuffer());
  }

  const filter = value => encodeURIComponent(String(value));
  const inFilter = values => `in.(${values.map(value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')})`;
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
  const publicPerson = row => row && ({
    id: row.id,
    name: row.full_name || row.name || 'Student',
    picture: row.picture || null,
  });

  async function usersByIds(ids) {
    const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
    if (!uniqueIds.length) return new Map();
    const users = await rows('users', `select=id,full_name,name,picture&id=${filter(inFilter(uniqueIds))}`);
    return new Map(users.map(user => [String(user.id), publicPerson(user)]));
  }

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
    async createPublicPost({ userId, title, content, attachment = null }) {
      const result = await write('public_posts', 'POST', '', { author_id: userId, title, content });
      const post = result[0];
      let attachmentRow = null;
      if (attachment) {
        try {
          await this.uploadNote(attachment.storageName, attachment.data, attachment.contentType);
          const saved = await write('public_post_attachments', 'POST', '', {
            post_id: post.id,
            original_name: attachment.filename,
            storage_name: attachment.storageName,
            content_type: attachment.contentType,
            size_bytes: attachment.data.length,
          });
          attachmentRow = saved[0];
        } catch (error) {
          await this.deleteNoteFile(attachment.storageName).catch(() => {});
          await write('public_posts', 'DELETE', `id=eq.${filter(post.id)}`, undefined, 'return=minimal').catch(() => {});
          throw error;
        }
      }
      const author = await this.getUserById(userId);
      return {
        id: post.id, authorId: post.author_id, author: publicPerson(author), title: post.title,
        content: post.content, createdAt: post.created_at, likeCount: 0, commentCount: 0,
        repostCount: 0, likedByMe: false, repostedByMe: false,
        attachment: attachmentRow ? {
          filename: attachmentRow.original_name,
          contentType: attachmentRow.content_type,
          sizeBytes: Number(attachmentRow.size_bytes),
          isImage: String(attachmentRow.content_type).startsWith('image/'),
          url: `/api/posts/${post.id}/attachment`,
        } : null,
      };
    },
    async getPostAttachment(postId) {
      return one('public_post_attachments', `select=*&post_id=eq.${filter(postId)}`);
    },
    async listPostAttachments(postIds) {
      if (!postIds.length) return [];
      return rows('public_post_attachments', `select=*&post_id=${filter(inFilter(postIds))}`);
    },
    async getPublicPostById(postId) {
      return one('public_posts', `select=*&id=eq.${filter(postId)}`);
    },
    async listPublicFeed(viewerId, limit = 50) {
      const posts = await rows('public_posts', `select=*&order=created_at.desc&limit=${Math.min(Math.max(Number(limit) || 50, 1), 100)}`);
      if (!posts.length) return [];
      const postIds = posts.map(post => String(post.id));
      const [authors, likes, reposts, attachments] = await Promise.all([
        usersByIds(posts.map(post => post.author_id)),
        rows('public_post_likes', `select=post_id&user_id=eq.${filter(viewerId)}&post_id=${filter(inFilter(postIds))}`),
        rows('public_post_reposts', `select=post_id&user_id=eq.${filter(viewerId)}&post_id=${filter(inFilter(postIds))}`),
        this.listPostAttachments(postIds),
      ]);
      const likedPostIds = new Set(likes.map(row => String(row.post_id)));
      const repostedPostIds = new Set(reposts.map(row => String(row.post_id)));
      const attachmentByPost = new Map(attachments.map(row => [String(row.post_id), row]));
      return posts.map(post => ({
        id: post.id,
        authorId: post.author_id,
        author: authors.get(String(post.author_id)) || { id: post.author_id, name: 'Student', picture: null },
        title: post.title,
        content: post.content,
        createdAt: post.created_at,
        likeCount: Number(post.like_count) || 0,
        commentCount: Number(post.comment_count) || 0,
        repostCount: Number(post.repost_count) || 0,
        likedByMe: likedPostIds.has(String(post.id)),
        repostedByMe: repostedPostIds.has(String(post.id)),
        attachment: attachmentByPost.has(String(post.id)) ? {
          filename: attachmentByPost.get(String(post.id)).original_name,
          contentType: attachmentByPost.get(String(post.id)).content_type,
          sizeBytes: Number(attachmentByPost.get(String(post.id)).size_bytes),
          isImage: String(attachmentByPost.get(String(post.id)).content_type).startsWith('image/'),
          url: `/api/posts/${post.id}/attachment`,
        } : null,
      }));
    },
    async listPostLikes(postId) {
      const likes = await rows('public_post_likes', `select=user_id,created_at&post_id=eq.${filter(postId)}&order=created_at.asc&limit=500`);
      const users = await usersByIds(likes.map(like => like.user_id));
      return likes.map(like => ({
        user: users.get(String(like.user_id)) || { id: like.user_id, name: 'Student', picture: null },
        createdAt: like.created_at,
      }));
    },
    async likePublicPost(postId, userId) {
      await write('public_post_likes', 'POST', 'on_conflict=post_id,user_id', { post_id: postId, user_id: userId }, 'resolution=ignore-duplicates,return=minimal');
    },
    async unlikePublicPost(postId, userId) {
      await write('public_post_likes', 'DELETE', `post_id=eq.${filter(postId)}&user_id=eq.${filter(userId)}`, undefined, 'return=minimal');
    },
    async listPostComments(postId) {
      const comments = await rows('public_post_comments', `select=id,post_id,author_id,content,created_at&post_id=eq.${filter(postId)}&order=created_at.desc&limit=200`);
      const users = await usersByIds(comments.map(comment => comment.author_id));
      return comments.reverse().map(comment => ({
        id: comment.id, postId: comment.post_id, content: comment.content,
        author: users.get(String(comment.author_id)) || { id: comment.author_id, name: 'Student', picture: null },
        createdAt: comment.created_at,
      }));
    },
    async createPostComment({ postId, userId, content }) {
      const result = await write('public_post_comments', 'POST', '', { post_id: postId, author_id: userId, content });
      const comment = result[0];
      const author = await this.getUserById(userId);
      return {
        id: comment.id, postId: comment.post_id, content: comment.content,
        author: publicPerson(author), createdAt: comment.created_at,
      };
    },
    async listPostReposts(postId) {
      const reposts = await rows('public_post_reposts', `select=user_id,created_at&post_id=eq.${filter(postId)}&order=created_at.asc&limit=500`);
      const users = await usersByIds(reposts.map(repost => repost.user_id));
      return reposts.map(repost => ({
        user: users.get(String(repost.user_id)) || { id: repost.user_id, name: 'Student', picture: null },
        createdAt: repost.created_at,
      }));
    },
    async repostPublicPost(postId, userId) {
      await write('public_post_reposts', 'POST', 'on_conflict=post_id,user_id', { post_id: postId, user_id: userId }, 'resolution=ignore-duplicates,return=minimal');
    },
    async unrepostPublicPost(postId, userId) {
      await write('public_post_reposts', 'DELETE', `post_id=eq.${filter(postId)}&user_id=eq.${filter(userId)}`, undefined, 'return=minimal');
    },
    async deletePublicPost(postId, userId) {
      const deleted = await write('public_posts', 'DELETE', `id=eq.${filter(postId)}&author_id=eq.${filter(userId)}`, undefined, 'return=representation');
      return Boolean(deleted?.length);
    },
    async listPublicDataByUser(userId) {
      const owner = filter(userId);
      const [posts, likes, comments, reposts, attachments] = await Promise.all([
        rows('public_posts', `select=id,title,content,like_count,comment_count,repost_count,created_at&author_id=eq.${owner}&order=created_at.desc`),
        rows('public_post_likes', `select=post_id,created_at&user_id=eq.${owner}&order=created_at.desc`),
        rows('public_post_comments', `select=id,post_id,content,created_at&author_id=eq.${owner}&order=created_at.desc`),
        rows('public_post_reposts', `select=post_id,created_at&user_id=eq.${owner}&order=created_at.desc`),
        (async () => {
          const authoredPosts = await rows('public_posts', `select=id&author_id=eq.${owner}`);
          return this.listPostAttachments(authoredPosts.map(post => String(post.id)));
        })(),
      ]);
      return { posts, likes, comments, reposts, attachments };
    },
    async createTodo({ userId, text, dueAt = null }) {
      const result = await write('todos', 'POST', '', { user_id: userId, text, ...(dueAt ? { due_at: dueAt } : {}) });
      const row = result[0];
      return { id: row.id, text: row.text, completed: Boolean(row.completed), dueAt: row.due_at, createdAt: row.created_at };
    },
    async listTodosByUser(userId) {
      return (await rows('todos', `select=*&user_id=eq.${filter(userId)}&order=id.desc`)).map(row => ({ id: row.id, text: row.text, completed: Boolean(row.completed), dueAt: row.due_at, createdAt: row.created_at }));
    },
    async getTodoByIdForUser(todoId, userId) {
      const row = await one('todos', `select=*&id=eq.${filter(todoId)}&user_id=eq.${filter(userId)}`);
      return row && { id: row.id, userId: row.user_id, text: row.text, completed: Boolean(row.completed), dueAt: row.due_at, createdAt: row.created_at };
    },
    async updateTodoForUser(todoId, userId, { completed, dueAt }) {
      await write('todos', 'PATCH', `id=eq.${filter(todoId)}&user_id=eq.${filter(userId)}`, { completed, due_at: dueAt });
      return this.getTodoByIdForUser(todoId, userId);
    },
    async deleteTodoForUser(todoId, userId) {
      await write('todos', 'DELETE', `id=eq.${filter(todoId)}&user_id=eq.${filter(userId)}`, undefined, 'return=minimal');
    },
    async logActivity(userId, eventType, details = {}) {
      await write('activity_log', 'POST', '', { user_id: userId || null, event_type: eventType, details });
    },
    async listActivityByUser(userId) {
      return rows('activity_log', `select=id,event_type,details,created_at&user_id=eq.${filter(userId)}&order=id.desc`);
    },
    async deleteAccount(userId) {
      const files = await rows('notes', `select=stored_name&user_id=eq.${filter(userId)}`);
      for (const file of files) await this.deleteNoteFile(file.stored_name);
      const posts = await rows('public_posts', `select=id&author_id=eq.${filter(userId)}`);
      const attachments = await this.listPostAttachments(posts.map(post => String(post.id)));
      for (const attachment of attachments) await this.deleteNoteFile(attachment.storage_name);
      await write('activity_log', 'DELETE', `user_id=eq.${filter(userId)}`, undefined, 'return=minimal');
      await write('users', 'DELETE', `id=eq.${filter(userId)}`, undefined, 'return=minimal');
    },
    async cleanup() {
      const now = Date.now();
      await write('sessions', 'DELETE', `expires_at=lte.${now}`, undefined, 'return=minimal');
      await write('oauth_states', 'DELETE', `expires_at=lte.${now}`, undefined, 'return=minimal');
    },
  };
}
