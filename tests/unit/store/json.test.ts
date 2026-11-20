import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createICloud, createJsonFiles } from '../../../src/store/index.ts';

// Rule: a JSON file is never read as empty or lost while a whole copy of it exists. A read
// falls back on the copies a write leaves (.tmp, then .bak) and puts the one it used back
// as the file; a file still in iCloud is waited for, never replaced by an older copy.

let dir = '';
let logged: string[] = [];
let away = new Set<string>();
const json = () => createJsonFiles({
  log: (source, detail) => logged.push(`${source}: ${String(detail)}`),
  icloud: createICloud({ platform: 'darwin', detect: (files) => new Set(files.filter((f) => away.has(f))) }),
  platform: process.platform,
});
const at = (name: string) => path.join(dir, name);
const read = (name: string) => fs.readFileSync(at(name), 'utf8');

beforeEach(() => { dir = fs.mkdtempSync(path.join(tmpdir(), 'neo-json-')); logged = []; away = new Set(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('a file that reads whole is returned as it is', () => {
  fs.writeFileSync(at('a.json'), '{"x":1}');
  assert.deepEqual(json().readJSON(at('a.json'), null), { x: 1 });
  assert.deepEqual(logged, []);
});

test('a file with no copies reads as the fallback; nothing is created', () => {
  assert.deepEqual(json().readJSON(at('a.json'), ['x']), ['x']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an emptied file comes back from its .bak, is put back whole, and the recovery is logged', () => {
  const j = json();
  j.writeJSON(at('a.json'), { v: 1 });
  j.writeJSON(at('a.json'), { v: 2 });
  fs.writeFileSync(at('a.json'), '');
  assert.deepEqual(j.readJSON(at('a.json'), null), { v: 1 });
  assert.deepEqual(JSON.parse(read('a.json')), { v: 1 });
  assert.match(logged.join('\n'), /recovered: .*a\.json was unreadable; restored from a\.json\.bak/);
});

test('a half-written file is read from the .tmp a write left, which is newer than the .bak', () => {
  const j = json();
  j.writeJSON(at('a.json'), { v: 1 });
  j.writeJSON(at('a.json'), { v: 2 });
  fs.writeFileSync(at('a.json.tmp'), '{"v":3}');
  fs.writeFileSync(at('a.json'), '{"v":');
  assert.deepEqual(j.readJSON(at('a.json'), null), { v: 3 });
});

test('a sidecar that exists only as its .tmp is recovered, not read as the fallback', () => {
  fs.writeFileSync(at('keepers.json.tmp'), JSON.stringify([{ id: 'd1', text: 'recover me' }]));
  assert.deepEqual(json().readJSON(at('keepers.json'), []), [{ id: 'd1', text: 'recover me' }]);
});

test('a file and its copies all unreadable reads as the fallback', () => {
  fs.writeFileSync(at('a.json'), '\0\0\0');
  fs.writeFileSync(at('a.json.bak'), '{"v"');
  assert.deepEqual(json().readJSON(at('a.json'), 'none'), 'none');
});

test('a file still in iCloud is an error, never a rollback to its .bak', () => {
  const j = json();
  j.writeJSON(at('a.json'), { v: 1 });
  j.writeJSON(at('a.json'), { v: 2 });
  away.add(at('a.json'));
  assert.throws(() => j.readJSON(at('a.json'), null), { code: 'cloud_only' });
  assert.deepEqual(JSON.parse(read('a.json')), { v: 2 }, 'left as it was');
});

test('a write keeps the version that read whole as .bak, and leaves nothing else behind', () => {
  const j = json();
  j.writeJSON(at('a.json'), { v: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
  j.writeJSON(at('a.json'), { v: 2 });
  assert.deepEqual(JSON.parse(read('a.json.bak')), { v: 1 });
  fs.writeFileSync(at('a.json'), '{"v"');
  j.writeJSON(at('a.json'), { v: 3 });
  assert.deepEqual(JSON.parse(read('a.json.bak')), { v: 1 }, 'a torn file is never made the spare');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'a.json.bak']);
});

test('a write never copies a file still in iCloud over its .bak', () => {
  const j = json();
  j.writeJSON(at('a.json'), { v: 1 });
  j.writeJSON(at('a.json'), { v: 2 });
  away.add(at('a.json'));
  j.writeJSON(at('a.json'), { v: 3 });
  assert.deepEqual(JSON.parse(read('a.json.bak')), { v: 1 });
});
