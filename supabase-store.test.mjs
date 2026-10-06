import test from 'node:test';
import assert from 'node:assert/strict';
import { openSupabaseStore } from './supabase-store.mjs';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('Supabase todo creation supports old schemas when no due date is set', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse([{ id: 12, user_id: 'user-1', text: 'Read chapter', completed: false, created_at: '2026-10-04T12:00:00Z' }], 201);
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    const todo = await store.createTodo({ userId: 'user-1', text: 'Read chapter' });
    assert.equal(todo.id, 12);
    assert.equal(todo.dueAt, undefined);
    assert.equal(JSON.parse(calls[0].init.body).due_at, undefined);
    assert.match(calls[0].url, /\/rest\/v1\/todos\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Supabase todo updates keep the owner filter and persist due dates', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.method === 'PATCH') return new Response(null, { status: 204 });
    return jsonResponse([{ id: 8, user_id: 'student/a', text: 'Study', completed: true, due_at: '2026-10-05T10:00:00Z', created_at: '2026-10-04T12:00:00Z' }]);
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    const todo = await store.updateTodoForUser(8, 'student/a', { completed: true, dueAt: '2026-10-05T10:00:00.000Z' });
    assert.equal(todo.dueAt, '2026-10-05T10:00:00Z');
    assert.match(calls[0].url, /user_id=eq\.student%2Fa/);
    assert.deepEqual(JSON.parse(calls[0].init.body), { completed: true, due_at: '2026-10-05T10:00:00.000Z' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Supabase account deletion removes private files and account rows in order', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rest/v1/notes?')) return jsonResponse([{ stored_name: 'owner/file one.pdf' }]);
    if (String(url).includes('/rest/v1/public_posts?')) return jsonResponse([]);
    return new Response(null, { status: 204 });
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    await store.deleteAccount('student-1');
    assert.equal(calls.length, 5);
    assert.equal(calls[1].init.method, 'DELETE');
    assert.match(calls[1].url, /\/storage\/v1\/object\/student-notes\/owner\/file%20one\.pdf$/);
    assert.match(calls[2].url, /\/rest\/v1\/public_posts\?/);
    assert.match(calls[3].url, /\/rest\/v1\/activity_log\?/);
    assert.match(calls[4].url, /\/rest\/v1\/users\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public feed maps author, cached counts, and viewer interaction state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const requestUrl = String(url);
    if (requestUrl.includes('/rest/v1/public_posts?')) return jsonResponse([{
      id: 31, author_id: 'author-1', title: 'Algebra', content: 'A useful identity',
      like_count: 4, comment_count: 2, repost_count: 1, created_at: '2026-10-06T08:00:00Z',
    }]);
    if (requestUrl.includes('/rest/v1/public_post_likes?')) return jsonResponse([{ post_id: 31 }]);
    if (requestUrl.includes('/rest/v1/public_post_reposts?')) return jsonResponse([]);
    if (requestUrl.includes('/rest/v1/public_post_attachments?')) return jsonResponse([{
      post_id: 31, original_name: 'diagram.png', content_type: 'image/png', size_bytes: 1200,
    }]);
    if (requestUrl.includes('/rest/v1/users?')) return jsonResponse([{ id: 'author-1', full_name: 'A Student', name: 'Google Name', picture: null }]);
    throw Error(`Unexpected request ${requestUrl}`);
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    const [post] = await store.listPublicFeed('viewer-1');
    assert.equal(post.author.name, 'A Student');
    assert.equal(post.likeCount, 4);
    assert.equal(post.commentCount, 2);
    assert.equal(post.repostCount, 1);
    assert.equal(post.likedByMe, true);
    assert.equal(post.repostedByMe, false);
    assert.equal(post.attachment.filename, 'diagram.png');
    assert.equal(post.attachment.isImage, true);
    assert.equal(post.attachment.url, '/api/posts/31/attachment');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public post creation uploads an optional attachment to private storage and records metadata', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rest/v1/public_posts?') && init.method === 'POST') return jsonResponse([{
      id: 31, author_id: 'author-1', title: 'Cell diagram', content: 'Labelled cells', created_at: '2026-10-06T08:00:00Z',
    }], 201);
    if (String(url).includes('/storage/v1/object/student-notes/')) return jsonResponse({ Key: 'stored' });
    if (String(url).includes('/rest/v1/public_post_attachments?')) return jsonResponse([{
      post_id: 31, original_name: 'cell.png', content_type: 'image/png', size_bytes: 4,
    }], 201);
    if (String(url).includes('/rest/v1/users?')) return jsonResponse([{
      id: 'author-1', full_name: 'A Student', name: 'A Student', picture: null,
    }]);
    throw Error(`Unexpected request ${url}`);
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    const post = await store.createPublicPost({
      userId: 'author-1', title: 'Cell diagram', content: 'Labelled cells',
      attachment: { filename: 'cell.png', contentType: 'image/png', storageName: 'private/public-posts/cell.png', data: Buffer.from('png!') },
    });
    assert.equal(post.attachment.filename, 'cell.png');
    assert.equal(post.attachment.isImage, true);
    const upload = calls.find(call => call.url.includes('/storage/v1/object/'));
    assert.equal(upload.init.method, 'POST');
    assert.equal(upload.init.body.toString(), 'png!');
    const metadata = calls.find(call => call.url.includes('/rest/v1/public_post_attachments?'));
    assert.equal(JSON.parse(metadata.init.body).storage_name, 'private/public-posts/cell.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('missing community schema returns a clear migration error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ code: 'PGRST205', message: 'Could not find table' }, 404);
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    await assert.rejects(store.listPublicFeed('viewer-1'), /Apply the public-community Supabase migration/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public like lists include the names of users who liked a note', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const requestUrl = String(url);
    if (requestUrl.includes('/rest/v1/public_post_likes?')) return jsonResponse([{ user_id: 'liker-1', created_at: '2026-10-06T08:05:00Z' }]);
    if (requestUrl.includes('/rest/v1/users?')) return jsonResponse([{ id: 'liker-1', full_name: 'Taylor', name: 'Taylor', picture: 'https://lh3.googleusercontent.com/avatar' }]);
    throw Error(`Unexpected request ${requestUrl}`);
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    const likes = await store.listPostLikes(31);
    assert.equal(likes.length, 1);
    assert.equal(likes[0].user.name, 'Taylor');
    assert.equal(likes[0].user.picture, 'https://lh3.googleusercontent.com/avatar');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public community account export is scoped to that account', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    return jsonResponse([]);
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    const exported = await store.listPublicDataByUser('student-1');
    assert.deepEqual(Object.keys(exported), ['posts', 'likes', 'comments', 'reposts', 'attachments']);
    assert.equal(calls.length, 5);
    assert.ok(calls.every(url => url.includes('author_id=eq.student-1') || url.includes('user_id=eq.student-1')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
