// Rules for an import telling the page store of the pages it writes (PageImport's `imported`):
// - Import-Announces-Each-Page-Once: each page an import writes fires one 'import' change
//   whose before is what the page held (empty for a new page) and whose after is the page
//   as the import leaves it, even when history is kept and the page is written in two steps;
// - Import-Who-Follows-Ownership: a wiki page whose sidecar makes it the librarian's is
//   announced as the librarian's; every other imported page, and every sources page, as the author's;
// - Import-Reaches-Gate-And-Pair: wired to the store's announce, an imported page reaches
//   the pair once and the gate once if it is the author's;
// - A callback that throws is logged and the import goes on.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { signalPageChanges } from '../../src/hoard/pages/signals.ts';
import { PageStore, type PageChange } from '../../src/hoard/pages/store.ts';
import { PageImport } from '../../src/hoard/wiki/page-import.ts';
import { tempDir } from './git-support.ts';

type T = { after(fn: () => void): void };

function setup(t: T, extra: { imported?: (c: PageChange) => void | Promise<void>; commit?: boolean } = {}) {
  const library = tempDir(t, 'hoard-lib-');
  const disk = tempDir(t, 'hoard-disk-');
  mkdirSync(path.join(disk, 'vault', '.obsidian'), { recursive: true });
  const lines: { level: string; message: string }[] = [];
  const seen: PageChange[] = [];
  let n = 0;
  const options = {
    library: () => library,
    now: () => new Date('2026-11-01T09:00:00.000Z'),
    newId: (prefix: string) => `${prefix}-t${(n++).toString().padStart(4, '0')}`,
    log: (level: string, message: string) => { lines.push({ level, message }); },
    imported: extra.imported ?? ((c: PageChange) => { seen.push(c); }),
    ...(extra.commit ? { commit: async () => {} } : {}),
  };
  const into = (tree: 'wiki' | 'sources') => new PageImport({ ...options, tree } as never);
  const put = (rel: string, data: string) => {
    const file = path.join(disk, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };
  return { library, into, put, seen, lines, read: (rel: string) => readFileSync(path.join(library, rel), 'utf8') };
}

test('Import-Announces-Each-Page-Once: a new page and an update each fire one import change with the bytes before and after', async (t) => {
  const s = setup(t);
  const owl = s.put('vault/Owl.md', 'Grey.\n');
  const sources = s.into('sources');
  await sources.apply(sources.sort([owl]));
  assert.deepEqual(s.seen.map((c) => [c.page, c.kind, c.who, c.before, c.after]), [['sources/Owl.html', 'import', 'author', '', s.read('sources/Owl.html')]]);
  const first = s.read('sources/Owl.html');
  writeFileSync(owl, 'Grey and white.\n');
  await sources.apply(sources.sort([owl]));
  assert.equal(s.seen.length, 2);
  assert.deepEqual([s.seen[1]!.page, s.seen[1]!.before, s.seen[1]!.after], ['sources/Owl.html', first, s.read('sources/Owl.html')]);
});

test('Import-Announces-Each-Page-Once: history kept, a page written in two steps is still announced once, with its final text', async (t) => {
  const s = setup(t, { commit: true });
  const quay = s.put('vault/Quay.md', 'Built of stone.\n');
  const wiki = s.into('wiki');
  await wiki.apply(wiki.sort([quay]));
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0]!.after, s.read('wiki/Quay.html'));
});

test('Import-Who-Follows-Ownership: a librarian-owned wiki page is the librarian\'s, every other page the author\'s', async (t) => {
  const s = setup(t);
  const lore = s.put('vault/Lore.md', '---\ntype: lore\n---\nThe quay is old.\n');
  const note = s.put('vault/Note.md', '---\ntype: note\n---\nA note.\n');
  const wiki = s.into('wiki');
  await wiki.apply(wiki.sort([lore, note]));
  const sources = s.into('sources');
  await sources.apply(sources.sort([lore]));
  assert.deepEqual(s.seen.map((c) => [c.page, c.who]).sort(), [
    ['sources/Lore.html', 'author'], ['wiki/Lore.html', 'librarian'], ['wiki/Note.html', 'author'],
  ]);
});

test('Import-Reaches-Gate-And-Pair: an imported page reaches the pair once, and the gate once when it is the author\'s', async (t) => {
  const store = new PageStore({ library: () => '', log: () => {} });
  const gate: string[] = [];
  const pair: string[] = [];
  signalPageChanges(store, { saved: (p) => { gate.push(p); } }, { landed: ({ page }) => { pair.push(page); } }, () => {});
  const s = setup(t, { imported: (c) => store.announce(c) });
  const lore = s.put('vault/Lore.md', '---\ntype: lore\n---\nThe quay is old.\n');
  const note = s.put('vault/Note.md', 'A note.\n');
  const wiki = s.into('wiki');
  await wiki.apply(wiki.sort([lore, note]));
  assert.deepEqual(gate, ['wiki/Note.html']);
  assert.deepEqual(pair.sort(), ['wiki/Lore.html', 'wiki/Note.html']);
});

test('A callback that throws is logged and the import goes on', async (t) => {
  const s = setup(t, { imported: () => { throw new Error('boom'); } });
  const owl = s.put('vault/Owl.md', 'Grey.\n');
  const sources = s.into('sources');
  const done = await sources.apply(sources.sort([owl]));
  assert.equal(done.imported.length, 1);
  assert.ok(s.lines.some((l) => l.level === 'error' && /announc/.test(l.message)), JSON.stringify(s.lines));
});
