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
    return new Response(null, { status: 204 });
  };
  try {
    const store = openSupabaseStore({ url: 'https://example.supabase.co', secretKey: 'test-only' });
    await store.deleteAccount('student-1');
    assert.equal(calls.length, 4);
    assert.equal(calls[1].init.method, 'DELETE');
    assert.match(calls[1].url, /\/storage\/v1\/object\/student-notes\/owner\/file%20one\.pdf$/);
    assert.match(calls[2].url, /\/rest\/v1\/activity_log\?/);
    assert.match(calls[3].url, /\/rest\/v1\/users\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
