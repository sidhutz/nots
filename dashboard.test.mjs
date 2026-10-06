import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('./public/dashboard.html', import.meta.url), 'utf8');

test('dashboard navigation links point to unique sections', () => {
  const nav = dashboard.match(/<nav class="dashboard-nav-wrap[\s\S]*?<\/nav>/)?.[0];
  assert.ok(nav, 'dashboard navigation should exist');
  assert.match(nav, /aria-label="Dashboard sections"/);
  const targets = [...nav.matchAll(/href="#([^"]+)"/g)].map(match => match[1]);
  assert.ok(targets.length >= 8, 'navigation should include all major dashboard sections');
  assert.equal(new Set(targets).size, targets.length, 'navigation targets should be unique');
  for (const target of targets) {
    assert.equal((dashboard.match(new RegExp(`id="${target}"`, 'g')) || []).length, 1, `#${target} should resolve to exactly one section`);
  }
  assert.match(nav, /href="#uploadNotes">[\s\S]*?Upload file/);
});
