import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { harness } from './support.ts';

// Rule: an export lands in the library's Exports/ folder under a name made of the name given
// and the time, and no name can reach outside that folder.

test('an export is written whole into Exports/, named for the book and the time', async () => {
  const h = harness();
  const file = await h.store.writeExport('My-Book', Buffer.from('%PDF-test'));
  assert.equal(path.dirname(file), h.at('Exports'));
  assert.match(path.basename(file), /^My-Book-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.pdf$/);
  assert.equal(fs.readFileSync(file, 'utf8'), '%PDF-test');
});

test('a name that is a path, or a dot name, writes nothing', async () => {
  const h = harness();
  for (const name of ['../escape', 'a/b', 'a\\b', '..', '.', '']) {
    await assert.rejects(h.store.writeExport(name, Buffer.from('x')), (e: { code?: string }) => e.code === 'bad_name', name);
  }
  assert.equal(fs.existsSync(h.at('Exports')), false, 'not even the folder');
  assert.equal(fs.existsSync(path.join(h.dir, '..', 'escape-2000.pdf')), false);
});
