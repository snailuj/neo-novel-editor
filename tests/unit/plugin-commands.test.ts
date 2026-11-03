import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Rule: every command the Plugins menu lists does something, so each id in plugin.json is
// bound by a neo.addCommand somewhere in src/hoard, and nothing binds an id the menu lacks.
const hoard = fileURLToPath(new URL('../../src/hoard/', import.meta.url));
const BIND = /addCommand\(\s*['"`]([\w-]+)['"`]/g;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? tsFiles(full) : d.name.endsWith('.ts') ? [full] : [];
  });
}

function bound(texts: string[]): Set<string> {
  return new Set(texts.flatMap((t) => [...t.matchAll(BIND)].map((m) => m[1]!)));
}

test('each Plugins menu command is bound, and each binding is on the menu', () => {
  const listed: string[] = JSON.parse(readFileSync(path.join(hoard, 'plugin.json'), 'utf8')).commands.map((c: { id: string }) => c.id);
  const ids = bound(tsFiles(hoard).map((f) => readFileSync(f, 'utf8')));
  assert.ok(listed.length > 5 && ids.size > 5, `found ${listed.length} listed, ${ids.size} bound`);
  assert.deepEqual(listed.filter((id) => !ids.has(id)), [], 'listed but never bound');
  assert.deepEqual([...ids].filter((id) => !listed.includes(id)), [], 'bound but not listed');
});

test('the check can fail: a binding is read from code', () => {
  assert.deepEqual([...bound(["neo.addCommand('run-ripple', run);", 'neo.addCommand(`x-y`, f)'])], ['run-ripple', 'x-y']);
});
