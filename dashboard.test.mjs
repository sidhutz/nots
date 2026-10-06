import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('./public/dashboard.html', import.meta.url), 'utf8');

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
