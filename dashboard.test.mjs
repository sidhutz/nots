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
});
