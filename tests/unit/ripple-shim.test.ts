// Rules for the adapter that stands in for stage 3 (ripple/stage3-shim.ts):
// - a page under sources/ is always the author's; a wiki page with no sidecar is too;
// - a wiki page is the librarian's when its sidecar's first voice is the librarian, or,
//   with no voice, its type is lore or project (the rule review/owner.ts keeps);
// - a librarian mark on a page lands in .neo/marks/<page id>.json as the schema says,
//   and a second mark is added to the first, not over it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateHoardMarksV1 } from '../../src/generated/validators.cjs';
import { shimMarks, shimOwnerOf } from '../../src/hoard/ripple/stage3-shim.ts';
import { pagesLibrary } from './pages-support.ts';

const sidecar = (frontmatter: unknown) => JSON.stringify({
  version: 1, source: { path: '/v/x.md', name: 'x', sha256: 'a'.repeat(64) }, frontmatter, imported: '2026-11-01T12:00:00.000Z',
});

test('ownership follows the sidecar for wiki pages and is the author\'s everywhere else', async (t) => {
  const { library, put, log } = pagesLibrary(t);
  put('.neo/pages/wiki/Lore.html.json', sidecar({ type: 'lore' }));
  put('.neo/pages/wiki/Voiced.html.json', sidecar({ type: 'lore', provenance: { author: ['snailuj', 'librarian'] } }));
  put('.neo/pages/wiki/Librarian.html.json', sidecar({ provenance: { author: 'Librarian' } }));
  put('.neo/pages/wiki/Plain.html.json', sidecar({ type: 'character' }));
  put('.neo/pages/sources/Lore.html.json', sidecar({ type: 'lore' }));
  put('.neo/pages/wiki/Torn.html.json', '{"version":');
  const owner = shimOwnerOf(log);
  const got = await Promise.all(['wiki/Lore.html', 'wiki/Voiced.html', 'wiki/Librarian.html', 'wiki/Plain.html', 'wiki/NoSidecar.html', 'sources/Lore.html', 'wiki/Torn.html']
    .map((id) => owner(library, id)));
  assert.deepEqual(got, ['librarian', 'author', 'librarian', 'author', 'author', 'author', 'author']);
});

test('a librarian mark lands in the page\'s marks file, after any already there', async (t) => {
  const { library, log } = pagesLibrary(t);
  const told: string[] = [];
  const marks = shimMarks({ library: () => library, head: async () => 'c'.repeat(40), wrote: (name) => told.push(name), now: () => new Date('2026-11-01T12:00:00Z'), log });
  const anchor = { exact: 'made of timber', prefix: 'The wall is ', suffix: '.', pIdx: 0, off: 12 };
  await marks.add({ page: 'sources/Notes/Harbour.html', kind: 'substitution', anchor, proposed: 'rebuilt in stone', body: 'From [[Storm]]' }, 'librarian');
  await marks.add({ page: 'sources/Notes/Harbour.html', kind: 'comment', anchor, body: 'A line to add.' }, 'librarian');
  const file = path.join(library, '.neo', 'marks', 'sources', 'Notes', 'Harbour.html.json');
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(validateHoardMarksV1(data), JSON.stringify(validateHoardMarksV1.errors));
  assert.deepEqual(data.marks.map((m) => [m.kind, m.created.who, m.anchor.commit]), [['substitution', 'librarian', 'c'.repeat(40)], ['comment', 'librarian', 'c'.repeat(40)]]);
  assert.deepEqual((await marks.list('sources/Notes/Harbour.html')).map((m) => m.kind), ['substitution', 'comment']);
  assert.deepEqual(await marks.list('wiki/Other.html'), []);
  assert.deepEqual(told, ['.neo', '.neo'], 'the history is told after each write');
});
