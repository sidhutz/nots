import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('./public/dashboard.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');

test('dashboard menu starts hidden and targets available single-view sections', () => {
  assert.match(dashboard, /id="menuToggle"[^>]*aria-expanded="false"[^>]*aria-controls="dashboardMenu"/);
  const menu = dashboard.match(/<nav id="dashboardMenu"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(menu, 'dashboard section menu should exist');
  assert.match(menu, /aria-label="Dashboard sections"[^>]*hidden/);
  const targets = [...menu.matchAll(/data-view-target="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(targets, ['feed', 'notes', 'upload', 'write', 'tasks', 'profile', 'account']);
  for (const target of targets) {
    assert.match(dashboard, new RegExp(`data-dashboard-view="${target}"`), `${target} should have a dashboard view`);
  }
  assert.match(menu, /data-view-target="upload">[\s\S]*?Upload a file/);
  assert.match(dashboard, /id="communityFeed"[^>]*data-view-active="true"/);
  assert.match(dashboard, /id="publicPostAttachment"[^>]*type="file"/);
  assert.match(dashboard, /aria-describedby="publicPostAttachmentHint"/);
});

test('public attachment composer and social feed have narrow phone layouts', () => {
  const css = readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 760px\)\s*\{[^}]*header \{ flex-direction: column/s);
  assert.match(css, /\.header-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.post-attachment-image img \{ display: block; width: 100%/);
});

test('open comment panels refresh and poll for comments from other students', () => {
  assert.match(app, /if \(!panel\.hidden\) await loadPostComments\(postId, panel\)/);
  assert.match(app, /fetch\(`\/api\/posts\/\$\{postId\}\/comments`, \{ cache: 'no-store' \}\)/);
  assert.match(app, /setInterval\(refreshOpenComments, 5000\)/);
  assert.match(app, /if \(viewName === 'feed'\) refreshOpenComments\(\)/);
  assert.match(app, /panel\.closest\('\[data-post-card\]'\)\?\.querySelector\('\[data-toggle-comments\]'\)/);
  assert.match(server, /'Cache-Control': 'no-store, max-age=0'/);
  assert.doesNotMatch(server, /if \(action === 'comments'\)[\s\S]{0,400}profile_completed/);
  assert.match(app, /data-comment-status aria-live="polite"/);
});

test('persistent login survives browser restarts and renews while active', () => {
  assert.match(server, /SESSION_TTL_SECONDS = 365 \* 24 \* 60 \* 60/);
  assert.match(server, /Expires=\$\{new Date\(Date\.now\(\) \+ age \* 1000\)\.toUTCString\(\)\}/);
  assert.match(server, /store\.extendSession\(tokenHash, now \+ SESSION_TTL_MS\)/);
  assert.match(server, /cookie\('sid', sid, SESSION_TTL_SECONDS\)/);
});

test('signed-in students can upload private and public notes before completing their optional profile', () => {
  assert.doesNotMatch(server, /if \(!user\.profile_completed\)[^\n]*(?:uploading notes|sharing a public note|adding personal notes)/);
  const renderUser = app.match(/function renderUser\(user\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(renderUser, 'renderUser should exist');
  assert.doesNotMatch(renderUser, /(?:uploadForm\.querySelector\('button'\)|noteFile|noteTitle|textNoteForm\.querySelector\('button'\)|textNoteTitle|textNoteContent|publicPostTitle|publicPostContent|publicPostAttachment|publishPostButton)\.disabled = !user\.profile_completed/);
  assert.match(renderUser, /Private files are visible only to your account/);
  assert.match(server, /userId: user\.id,[\s\S]{0,100}title,[\s\S]{0,100}originalName/);
});

test('students can like comments, inspect who liked them, and the header calls navigation Menu', () => {
  const migration = readFileSync(new URL('./supabase-migrations/20261007_public_comment_likes.sql', import.meta.url), 'utf8');
  assert.match(dashboard, /id="menuToggle"[^>]*>☰ Menu/);
  assert.match(app, /data-like-comment aria-pressed/);
  assert.match(app, /data-show-comment-likers/);
  assert.match(app, /\/api\/posts\/\$\{postId\}\/comments\/\$\{commentId\}\/likes/);
  assert.match(server, /public_comment_likes/);
  assert.match(server, /listPostComments\(postId, user\.id\)/);
  assert.match(migration, /create table if not exists public\.public_comment_likes/);
  assert.match(migration, /on delete cascade/);
  assert.match(migration, /sync_comment_like_count/);
});
