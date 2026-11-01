// Rules: renaming a page moves its marks to the new id; a rename interrupted after the page
// moved still ends with the marks at the new id after recovery. A rename moves the page and its sidecar and rewrites the links that resolve to
// it, in pages of both trees and in NEO chapters, as one commit credited to the author;
// it never writes the open book's chapters, and hands their edits back; it refuses a
// title the tree holds; and if it stops part way, running it again finishes it without
// rewriting anything twice. Page names here are neutral words.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { PageRefused } from '../../src/hoard/pages/identity.ts';
import { PageStore } from '../../src/hoard/pages/store.ts';
import { validateHoardPageV1 } from '../../src/generated/validators.cjs';
import { isolateGitConfig, log, tempDir, tempLibrary } from './git-support.ts';
import { pagesLibrary } from './pages-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
type T = { after(fn: () => void): void };

const SIDECAR = JSON.stringify({
  version: 1, source: { path: '/vault/Harbour.md', name: 'Harbour', sha256: 'a'.repeat(64) }, frontmatter: null, imported: '2026-10-15T22:00:00.000Z',
}, null, 2);
const MARKS = '{"version":1,"marks":[]}\n';
const INDEX = [
  '<p>[[Harbour]]</p>', '<p>[[Harbour|the port]]</p>', '<p>[[harbour#^b1]]</p>', '<p>[[Harbour#Docks]]</p>',
  '<p>[[Harbour Master]] [[Lantern]]</p>', '<p>`[[Harbour]]` kept</p>', '<p class="wiki-code">[[Harbour]]</p>',
].join('');
const INDEX_AFTER = [
  '<p>[[Port]]</p>', '<p>[[Port|the port]]</p>', '<p>[[Port#^b1]]</p>', '<p>[[Port#Docks]]</p>',
  '<p>[[Harbour Master]] [[Lantern]]</p>', '<p>`[[Harbour]]` kept</p>', '<p class="wiki-code">[[Harbour]]</p>',
].join('');

// The same small library in every test: a page with a sidecar and a link to itself, a
// shadowed source of the same title, and links from both trees and from two books.
const FILES: Record<string, string> = {
  'wiki/People/Harbour.html': '<p data-block="a1">The wall. See [[Harbour]] itself.</p>',
  '.neo/pages/wiki/People/Harbour.html.json': SIDECAR,
  '.neo/marks/wiki/People/Harbour.html.json': MARKS,
  'wiki/Index.html': INDEX,
  'wiki/Lantern.html': '<p>No link to the page.</p>',
  'sources/Harbour.html': '<p>A source of the same title. [[Lantern]]</p>',
  'sources/Notes.html': '<p>See [[Harbour|x]].</p>',
  'book-fox-1/book.json': '{"id":"book-fox-1","chapterOrder":["c1","c2"]}',
  'book-fox-1/chapters/c1.html': '<p>Down to [[Harbour]] at dusk.</p><p>[[HARBOUR#^z]]</p>',
  'book-fox-1/chapters/c2.html': '<p>Nothing here.</p>',
  'book-owl-2/book.json': '{"id":"book-owl-2","chapterOrder":["c1"]}',
  'book-owl-2/chapters/c1.html': '<p>[[Harbour]] again.</p>',
};

function fixture(t: T, extra = {}) {
  const lib = pagesLibrary(t, extra);
  for (const [rel, text] of Object.entries(FILES)) lib.put(rel, text);
  return lib;
}

const FROM = 'wiki/People/Harbour.html';

test('a rename moves the page and its sidecar and rewrites every form of link in both trees and in chapters', async (t) => {
  const { store, get, has } = fixture(t);
  assert.ok(has(FROM) && has('.neo/pages/wiki/People/Harbour.html.json'), 'the fixture reached its state');
  assert.match(get('wiki/Index.html'), /\[\[Harbour#Docks\]\]/);

  const done = await store.rename(FROM, 'Places/Port.html', null);

  assert.equal(done.id, 'wiki/Places/Port.html');
  assert.equal(has(FROM), false);
  assert.equal(get('wiki/Places/Port.html'), '<p data-block="a1">The wall. See [[Port]] itself.</p>', 'a link to itself follows it');
  assert.equal(has('.neo/pages/wiki/People/Harbour.html.json'), false);
  assert.equal(get('.neo/pages/wiki/Places/Port.html.json'), SIDECAR, 'the sidecar moved byte for byte');
  assert.ok(validateHoardPageV1(JSON.parse(get('.neo/pages/wiki/Places/Port.html.json'))));
  assert.equal(get('wiki/Index.html'), INDEX_AFTER);
  assert.equal(get('sources/Notes.html'), '<p>See [[Port|x]].</p>');
  assert.equal(get('book-fox-1/chapters/c1.html'), '<p>Down to [[Port]] at dusk.</p><p>[[Port#^z]]</p>');
  assert.equal(get('book-owl-2/chapters/c1.html'), '<p>[[Port]] again.</p>');
  assert.equal(get('book-fox-1/chapters/c2.html'), '<p>Nothing here.</p>');
  assert.equal(get('wiki/Lantern.html'), FILES['wiki/Lantern.html'], 'a page without a link is not rewritten');
  assert.deepEqual(done.deferred, []);
  assert.equal(done.rewrittenFiles, 5);
  assert.equal(done.rewrittenLinks, 4 + 1 + 1 + 2 + 1);
  assert.equal(has('.neo/pages/.rename.json'), false, 'the note of the rename in progress is gone');
});

test('a rename rewrites only links that resolve to the renamed page', async (t) => {
  // sources/Harbour is shadowed by the wiki page of the same title: every [[Harbour]] means the wiki page
  const shadowed = fixture(t);
  const before = Object.fromEntries(Object.keys(FILES).map((rel) => [rel, shadowed.get(rel)]));
  const done = await shadowed.store.rename('sources/Harbour.html', 'Quay.html', null);
  assert.equal(done.rewrittenFiles, 0);
  for (const rel of Object.keys(FILES).filter((r) => r !== 'sources/Harbour.html')) assert.equal(shadowed.get(rel), before[rel], rel);
  assert.equal(shadowed.has('sources/Quay.html'), true);

  // with no wiki page of that title, the same source is what the links reach
  const alone = pagesLibrary(t);
  alone.put('sources/Harbour.html', '<p>s</p>');
  alone.put('wiki/Index.html', '<p>[[Harbour]]</p>');
  assert.equal((await alone.store.rename('sources/Harbour.html', 'Quay.html', null)).rewrittenFiles, 1);
  assert.equal(alone.get('wiki/Index.html'), '<p>[[Quay]]</p>');
});

test('moving a page to another folder with the same title rewrites nothing', async (t) => {
  const { store, get, has } = fixture(t);
  const done = await store.rename(FROM, 'Elsewhere/Harbour.html', null);
  assert.equal(done.id, 'wiki/Elsewhere/Harbour.html');
  assert.equal(get('wiki/Index.html'), INDEX);
  assert.equal(done.rewrittenFiles, 0);
  assert.equal(has('.neo/pages/wiki/Elsewhere/Harbour.html.json'), true);
});

test('a rename to the page\'s own path changes nothing', async (t) => {
  const { store, get, logged } = fixture(t);
  const done = await store.rename(FROM, 'People/Harbour.html', null);
  assert.equal(done.id, FROM);
  assert.equal(done.rewrittenFiles, 0);
  assert.equal(get('wiki/Index.html'), INDEX);
  assert.equal(logged('pages.rename').length, 0);
});

test('a rename changing only the case of a title rewrites the links to match', async (t) => {
  const { store, get, library } = fixture(t);
  await store.rename(FROM, 'People/HARBOUR.html', null);
  assert.equal(get('sources/Notes.html'), '<p>See [[HARBOUR|x]].</p>');
  assert.equal(readdirSync(path.join(library, 'wiki/People')).includes('HARBOUR.html'), true);
});

test('chapters of the open book are not written; their edits come back for the window', async (t) => {
  const { store, get, has } = fixture(t);
  const open = FILES['book-fox-1/chapters/c1.html']!;
  const done = await store.rename(FROM, 'Places/Port.html', 'book-fox-1');

  assert.equal(get('book-fox-1/chapters/c1.html'), open, 'the window owns this file, and autosave would write over it');
  assert.equal(get('book-owl-2/chapters/c1.html'), '<p>[[Port]] again.</p>', 'another book is written');
  assert.deepEqual(done.deferred, [{
    bookId: 'book-fox-1', chId: 'c1',
    edits: [
      { pIdx: 0, off: 8, len: 11, expected: '[[Harbour]]', replacement: '[[Port]]' },
      { pIdx: 1, off: 0, len: 14, expected: '[[HARBOUR#^z]]', replacement: '[[Port#^z]]' },
    ],
  }]);
  assert.equal(done.rewrittenFiles, 4, 'the open chapter is not counted as written');
  assert.equal(has('.neo/pages/.rename.json'), false);
});

test('a title the tree holds is refused, folded as links fold it, and nothing moves', async (t) => {
  const { store, get, has, put, logged } = fixture(t);
  put('wiki/Places/Port.html', '<p>already a page</p>');
  await assert.rejects(store.rename(FROM, 'Else/PORT.html', null), (e: PageRefused) => e.code === 'taken');
  assert.equal(has(FROM), true);
  assert.equal(get('wiki/Index.html'), INDEX);
  assert.equal(has('.neo/pages/.rename.json'), false);
  assert.equal(logged('pages.refused').length, 1);
});

// Rule: a rename never moves links between the trees; a new title the other tree holds is refused.
test('a rename onto a title the other tree holds is refused both ways, and nothing moves', async (t) => {
  const { store, get, has, put, logged } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>w</p>');
  put('sources/Moon.html', '<p>s</p>');
  put('wiki/Index.html', '<p>[[Tide]] [[Moon]]</p>');
  await assert.rejects(store.rename('sources/Moon.html', 'Deep/TIDE.html', null), (e: PageRefused) => e.code === 'other-tree');
  await assert.rejects(store.rename('wiki/Tide.html', 'moon.html', null), (e: PageRefused) => e.code === 'other-tree');
  assert.ok(has('sources/Moon.html') && has('wiki/Tide.html'), 'neither page moved');
  assert.equal(get('wiki/Index.html'), '<p>[[Tide]] [[Moon]]</p>', 'no link was re-pointed');
  assert.deepEqual(logged('pages.refused').map((l) => (l.data as { code: string }).code), ['other-tree', 'other-tree']);
  assert.equal((await store.rename('sources/Moon.html', 'Deep/Moon.html', null)).id, 'sources/Deep/Moon.html', 'a move keeping its own title is allowed');
});

test('a rename refuses a missing page, a title no link can name, and a path out of the tree, and logs each', async (t) => {
  const { store, has, logged } = fixture(t);
  await assert.rejects(store.rename('wiki/Nothing.html', 'X.html', null), (e: PageRefused) => e.code === 'missing');
  for (const bad of ['A#1.html', 'A|B.html', '../Out.html', '/abs/Out.html', 'a\\b.html', '.hid/X.html']) {
    await assert.rejects(store.rename(FROM, bad, null), PageRefused, bad);
  }
  await assert.rejects(store.rename('../library.json', 'X.html', null), PageRefused);
  assert.equal(has(FROM), true);
  assert.equal(logged('pages.refused').length, 8);
});

test('a rename logs the files it rewrote and how long it took', async (t) => {
  const { store, logged } = fixture(t);
  await store.rename(FROM, 'Places/Port.html', null);
  const [line] = logged('pages.rename');
  const data = line!.data as Record<string, unknown>;
  assert.equal(data['from'], FROM);
  assert.equal(data['to'], 'wiki/Places/Port.html');
  assert.equal(data['files'], 5);
  assert.equal(data['links'], 9);
  assert.equal(typeof data['ms'], 'number');
});

// Every file of a library with its content, for comparing a rename that was stopped and finished with a clean one.
function snapshot(library: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const d of readdirSync(path.join(library, rel), { withFileTypes: true })) {
      const at = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(at);
      else out[at] = readFileSync(path.join(library, at), 'utf8');
    }
  };
  walk('');
  return out;
}

test('a rename that stops part way is finished by running it again, and nothing is rewritten twice', async (t) => {
  const clean = fixture(t);
  await clean.store.rename(FROM, 'Places/Port.html', null);

  let rewrites = 0;
  const broken = fixture(t, { onStep: (step: string) => { if (step === 'rewrite' && ++rewrites === 3) throw new Error('disk full'); } });
  await assert.rejects(broken.store.rename(FROM, 'Places/Port.html', null), /disk full/);
  assert.equal(broken.has(FROM), false, 'the page had moved');
  assert.equal(broken.has('.neo/pages/.rename.json'), true, 'the rename is noted as unfinished');
  const half = Object.keys(FILES).filter((rel) => broken.has(rel) && broken.get(rel) !== FILES[rel]);
  assert.ok(half.length > 0 && half.length < 5, `part of it was done: ${half.join(', ')}`);

  const again = new PageStore({ library: () => broken.library, log: broken.log });
  const done = await again.rename(FROM, 'Places/Port.html', null);
  assert.equal(done.id, 'wiki/Places/Port.html');
  assert.ok(done.rewrittenFiles < 5, 'the files already done were not rewritten');
  assert.equal(broken.has('.neo/pages/.rename.json'), false);
  assert.deepEqual(snapshot(broken.library), snapshot(clean.library));
});

test('starting up finishes a rename that NEO stopped in the middle of', async (t) => {
  let rewrites = 0;
  const broken = fixture(t, { onStep: (step: string) => { if (step === 'rewrite' && ++rewrites === 2) throw new Error('power cut'); } });
  await assert.rejects(broken.store.rename(FROM, 'Places/Port.html', null), /power cut/);
  const restarted = new PageStore({ library: () => broken.library, log: broken.log });
  const finished = await restarted.recover(null);
  assert.equal(finished?.id, 'wiki/Places/Port.html');
  assert.equal(broken.get('wiki/Index.html'), INDEX_AFTER);
  assert.equal(broken.get('sources/Notes.html'), '<p>See [[Port|x]].</p>');
  assert.equal(await restarted.recover(null), null, 'nothing is left to finish');
});

test('renaming a page moves its marks to the new id', async (t) => {
  const { store, get, has } = fixture(t);
  assert.ok(has('.neo/marks/wiki/People/Harbour.html.json'), 'the fixture reached its state');
  await store.rename(FROM, 'Places/Port.html', null);
  assert.equal(has('.neo/marks/wiki/People/Harbour.html.json'), false, 'none is left at the old id');
  assert.equal(get('.neo/marks/wiki/Places/Port.html.json'), MARKS, 'the marks moved byte for byte');
});

for (const stopAt of ['sidecar', 'marks', 'rewrite'] as const) {
  test(`a rename interrupted at the ${stopAt} step still ends with the marks at the new id after recovery`, async (t) => {
    let stopped = false;
    const broken = fixture(t, { onStep: (step: string) => { if (step === stopAt && !stopped) { stopped = true; throw new Error('power cut'); } } });
    await assert.rejects(broken.store.rename(FROM, 'Places/Port.html', null), /power cut/);
    assert.ok(stopped, 'the rename reached the step it was stopped at');
    assert.equal(broken.has('wiki/Places/Port.html'), true, 'the page had moved');
    const restarted = new PageStore({ library: () => broken.library, log: broken.log });
    await restarted.recover(null);
    assert.equal(broken.has('.neo/marks/wiki/People/Harbour.html.json'), false, 'none is left at the old id');
    assert.equal(broken.get('.neo/marks/wiki/Places/Port.html.json'), MARKS);
    assert.equal(await restarted.recover(null), null, 'nothing is left to finish');
  });
}

// A library kept in git, with the fixture committed, and a store whose history is that layer.
async function tracked(t: T, extra = {}) {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const layer = new GitLayer({
    git: lib.git, library: lib.library, settings: resolveSettings({}, () => {}),
    attributesFile: path.join(tempDir(t), 'attributes'),
    textconv: { command: `"${process.execPath}" "${path.join(root, 'tools', 'git', 'neo-textconv.js')}"` },
    log: () => {},
  });
  t.after(async () => { layer.stop(); await layer.drained(); });
  await layer.open();
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(lib.library, rel)), { recursive: true });
    writeFileSync(path.join(lib.library, rel), text);
  }
  await layer.keepHistory();
  const store = new PageStore({ library: () => lib.library, layer, log: () => {}, ...extra });
  const commits = () => log(lib.git, lib.library, '%an|%(trailers:key=Neo-Checkpoint,valueonly)').then((ls) => ls.map((l) => l.replace(/\s+$/, '')));
  return { lib, store, layer, commits };
}

test('a rename is one commit credited to the author, holding the move, the sidecar and every rewritten file', async (t) => {
  const { lib, store, commits } = await tracked(t);
  const before = (await commits()).length;
  writeFileSync(path.join(lib.library, 'wiki/Lantern.html'), '<p>Words the writer typed meanwhile.</p>');

  await store.rename(FROM, 'Places/Port.html', null);

  const history = await commits();
  assert.equal(history.length, before + 2, 'the pending words, then the rename');
  assert.deepEqual(history.slice(0, 2), ['Ada|page-rename', 'Ada|page-before']);
  const { stdout } = await lib.git.run(lib.library, ['show', '--no-renames', '--name-status', '--format=', 'HEAD']);
  const changed = stdout.split('\n').filter(Boolean).map((l) => l.replace(/\t/g, ' ')).sort();
  assert.deepEqual(changed, [
    'D .neo/pages/wiki/People/Harbour.html.json', 'A .neo/pages/wiki/Places/Port.html.json',
    'D .neo/marks/wiki/People/Harbour.html.json', 'A .neo/marks/wiki/Places/Port.html.json',
    'D wiki/People/Harbour.html', 'A wiki/Places/Port.html',
    'M wiki/Index.html', 'M sources/Notes.html', 'M book-fox-1/chapters/c1.html', 'M book-owl-2/chapters/c1.html',
    'A .neo/pages/renames.json',
  ].sort());
  const rest = await lib.git.run(lib.library, ['status', '--porcelain']);
  assert.equal(rest.stdout.trim(), '', 'the library is clean, the rename note included');
  assert.equal(existsSync(path.join(lib.library, '.neo/pages/.rename.json')), false);
});

test('a rename stopped part way, with history kept, is finished by running it again', async (t) => {
  let rewrites = 0;
  const { lib, store, layer, commits } = await tracked(t, { onStep: (step: string) => { if (step === 'rewrite' && ++rewrites === 3) throw new Error('disk full'); } });
  await assert.rejects(store.rename(FROM, 'Places/Port.html', null), /disk full/);
  const again = new PageStore({ library: () => lib.library, layer, log: () => {} });
  const done = await again.rename(FROM, 'Places/Port.html', null);
  assert.equal(done.id, 'wiki/Places/Port.html');
  const rest = await lib.git.run(lib.library, ['status', '--porcelain']);
  assert.equal(rest.stdout.trim(), '');
  assert.ok((await commits()).slice(0, 4).every((c) => c.startsWith('Ada|')), 'every commit of it is the author\'s');
  assert.equal(readFileSync(path.join(lib.library, 'wiki/Index.html'), 'utf8'), INDEX_AFTER);
});

test('a different rename started while one is unfinished finishes the first', async (t) => {
  let rewrites = 0;
  const left = fixture(t, { onStep: (step: string) => { if (step === 'rewrite' && ++rewrites === 2) throw new Error('power cut'); } });
  await assert.rejects(left.store.rename(FROM, 'Places/Port.html', null), /power cut/);
  const next = new PageStore({ library: () => left.library, log: left.log });
  await next.rename('wiki/Lantern.html', 'Beacon.html', null);
  assert.equal(left.get('wiki/Index.html'), INDEX_AFTER.replace('[[Lantern]]', '[[Beacon]]'));
  assert.equal(left.has('wiki/Beacon.html'), true);
  assert.equal(left.has('.neo/pages/.rename.json'), false);
});

// Rule: a write acknowledged as landed is never undone by a rename running beside it.
test('a write sent while a rename runs is never acknowledged and then written over', async (t) => {
  const big = `<p>[[Harbour]]</p>${'<p>filler text</p>'.repeat(50000)}`;
  for (let round = 0; round < 5; round++) {
    let sent: Promise<unknown> | null = null;
    const lib = pagesLibrary(t, { onStep: (step: string) => { if (step === 'move' && !sent) sent = lib.store.write('wiki/Index.html', big, `${big}<p>TYPED</p>`); } });
    lib.put('wiki/Harbour.html', '<p>h</p>');
    lib.put('wiki/Index.html', big);
    await lib.store.rename('wiki/Harbour.html', 'Port.html', null);
    assert.ok(sent, 'the write was sent part way through the rename');
    const written = await sent;
    const now = lib.get('wiki/Index.html');
    assert.ok(now.startsWith('<p>[[Port]]</p>'), 'the rename rewrote the link');
    if ((written as { ok: boolean }).ok) assert.ok(now.includes('TYPED'), `round ${round}: an acknowledged write was lost`);
    else assert.deepEqual(written, { ok: false, reason: 'stale' }, 'the writer is told the page moved on');
  }
});

// Rule: a rename writes a file only while it still holds what the rename read.
test('a rename leaves alone a file changed from outside after it was read, and logs it', async (t) => {
  const { store, get, put, logged } = fixture(t, {
    onStep: (step: string, file: string) => { if (step === 'rewrite' && file === 'wiki/Index.html') put('wiki/Index.html', '<p>[[Harbour]] typed elsewhere</p>'); },
  });
  const done = await store.rename(FROM, 'Places/Port.html', null);
  assert.equal(get('wiki/Index.html'), '<p>[[Harbour]] typed elsewhere</p>', 'the outside change stands');
  assert.equal(get('sources/Notes.html'), '<p>See [[Port|x]].</p>', 'the other files were rewritten');
  assert.equal(done.rewrittenFiles, 4);
  assert.deepEqual(logged('pages.rename.changed').map((l) => (l.data as { file: string }).file), ['wiki/Index.html']);
});

// Rule: asking again for a rename that has already happened succeeds and changes nothing.
test('a rename repeated after it succeeded is a logged no-op, not a missing page', async (t) => {
  const { store, get, logged } = fixture(t);
  await store.rename(FROM, 'Places/Port.html', null);
  const after = get('wiki/Index.html');
  const again = await store.rename(FROM, 'Places/Port.html', null);
  assert.deepEqual(again, { id: 'wiki/Places/Port.html', from: FROM, rewrittenFiles: 0, rewrittenLinks: 0, skipped: 0, deferred: [] });
  assert.equal(get('wiki/Index.html'), after);
  assert.equal(logged('pages.rename.done-already').length, 1);
  assert.equal(logged('pages.refused').length, 0);
  // with neither the page nor its target there, it is still refused
  await assert.rejects(store.rename(FROM, 'Places/Quay.html', null), (e: PageRefused) => e.code === 'missing');
});

// Rule: only a rename that this library recorded as finished is answered as done already.
test('a rename of a page that is gone is refused as before when no finished rename matches it', async (t) => {
  const { store, put, has, get, library } = fixture(t);
  put('wiki/Places/Port.html', '<p>another page by that name</p>');
  await assert.rejects(store.rename('wiki/Never.html', 'Places/Port.html', null), (e: PageRefused) => e.code === 'missing');
  // a page moved away by sync, while another page holds the name it was to take
  await store.rename('wiki/Lantern.html', 'Beacon.html', null);
  await assert.rejects(store.rename('wiki/Lantern.html', 'Places/Port.html', null), (e: PageRefused) => e.code === 'missing');
  assert.equal(get('wiki/Places/Port.html'), '<p>another page by that name</p>');
  // the record is the library's, so a new store answers the finished rename too, and the record stays bounded
  const record = JSON.parse(get('.neo/pages/renames.json')) as { from: string; to: string }[];
  assert.deepEqual(record.at(-1), { from: 'wiki/Lantern.html', to: 'wiki/Beacon.html' });
  assert.equal((await new PageStore({ library: () => library, log: () => {} }).rename('wiki/Lantern.html', 'Beacon.html', null)).id, 'wiki/Beacon.html');
  assert.equal(has('wiki/Lantern.html'), false);
});

test('the record of finished renames keeps the last fifty', async (t) => {
  const { store, put, get } = pagesLibrary(t);
  put('wiki/P0.html', '<p>p</p>');
  for (let i = 0; i < 55; i++) await store.rename(`wiki/P${i}.html`, `P${i + 1}.html`, null);
  const record = JSON.parse(get('.neo/pages/renames.json')) as { from: string; to: string }[];
  assert.equal(record.length, 50);
  assert.deepEqual(record[0], { from: 'wiki/P5.html', to: 'wiki/P6.html' });
});

// Rule: a rename never writes its note unless the target path is free on disk, whatever
// the cached titles say, so a refused rename leaves nothing to block the next one.
test('a rename onto a file that arrived by sync is refused as taken, leaves no note, and the next rename works', async (t) => {
  const { store, put, get, has, logged } = fixture(t);
  await store.list();
  put('wiki/Places/Port.html', '<p>arrived from another device</p>');
  await assert.rejects(store.rename(FROM, 'Places/Port.html', null), (e: PageRefused) => e.code === 'taken');
  assert.equal(has('.neo/pages/.rename.json'), false, 'no note of a rename is left');
  assert.equal(has(FROM), true);
  assert.equal(get('wiki/Places/Port.html'), '<p>arrived from another device</p>');
  assert.equal(get('wiki/Index.html'), INDEX);
  assert.equal(logged('pages.refused').length, 1);
  assert.equal((await store.rename(FROM, 'Places/Quay.html', null)).id, 'wiki/Places/Quay.html');
  assert.equal(await store.recover(null), null);
});

// Rule: recovery acts only on a note whose every path is a page id or a chapter of the
// library, so a note written by hand can never move or rewrite a file outside it.
test('a note naming paths out of the library is ignored at recovery, and nothing outside changes', async (t) => {
  const outside = tempDir(t, 'hoard-outside-');
  writeFileSync(path.join(outside, 'Secret.html'), '<p>[[Harbour]]</p>');
  const away = path.relative(fixture(t).library, outside).split(path.sep).join('/');
  const notes = [
    { from: `wiki/../${away}/Secret.html`, to: 'wiki/Stolen.html', files: [] },
    { from: FROM, to: `wiki/../${away}/Moved.html`, files: [] },
    { from: FROM, to: 'sources/Port.html', files: [] },
    { from: FROM, to: 'wiki/Places/Port.html', files: [`${away}/Secret.html`] },
    { from: FROM, to: 'wiki/Places/Port.html', files: ['book-fox-1/chapters/../../wiki/Index.html'] },
  ];
  for (const note of notes) {
    const lib = fixture(t);
    lib.put('.neo/pages/.rename.json', JSON.stringify({ version: 1, ...note, at: '2026-10-15T22:00:00.000Z' }));
    assert.equal(await lib.store.recover(null), null, JSON.stringify(note));
    assert.equal(lib.has(FROM), true, 'the page did not move');
    assert.equal(lib.get('wiki/Index.html'), INDEX);
    assert.ok(lib.lines.some((l) => l.level === 'warn' && /not a safe rename note/.test(l.message)), 'the note is logged as ignored');
  }
  assert.deepEqual(readdirSync(outside), ['Secret.html']);
  assert.equal(readFileSync(path.join(outside, 'Secret.html'), 'utf8'), '<p>[[Harbour]]</p>');
});

// Rule: a rename of a page whose file is gone is refused before its note is written.
test('a rename of a page deleted since the titles were walked is refused as missing, leaves no note, and the next rename works', async (t) => {
  const { store, library, has } = fixture(t);
  await store.list();
  rmSync(path.join(library, FROM));
  await assert.rejects(store.rename(FROM, 'Places/Port.html', null), (e: PageRefused) => e.code === 'missing');
  assert.equal(has('.neo/pages/.rename.json'), false, 'no note of a rename is left');
  assert.equal(has('wiki/Places/Port.html'), false);
  assert.equal((await store.rename('wiki/Lantern.html', 'Lamp.html', null)).id, 'wiki/Lamp.html');
  assert.equal(await store.recover(null), null);
});

// Rule: a rename onto an id with a leftover sidecar or marks file is refused before anything moves.
for (const [what, leftover] of [['sidecar', '.neo/pages/wiki/Places/Port.html.json'], ['marks file', '.neo/marks/wiki/Places/Port.html.json']] as const) {
  test(`a rename onto an id with a leftover ${what} is refused before anything moves, and succeeds once it is gone`, async (t) => {
    const { store, put, get, has, library } = fixture(t);
    put(leftover, '{"left":"over"}');
    const was = Object.fromEntries(Object.keys(FILES).map((rel) => [rel, get(rel)]));
    await assert.rejects(store.rename(FROM, 'Places/Port.html', null), (e: PageRefused) => e.code === 'taken' && e.message.includes(leftover));
    await assert.rejects(store.rename(FROM, 'Places/Port.html', null), (e: PageRefused) => e.code === 'taken', 'a retry is refused the same way, not stuck on a journal');
    assert.equal(has('.neo/pages/.rename.json'), false, 'no note of a rename was written');
    assert.equal(has('wiki/Places/Port.html'), false, 'the page did not move');
    assert.equal(get(leftover), '{"left":"over"}', 'the leftover is untouched');
    for (const [rel, text] of Object.entries(was)) assert.equal(get(rel), text, rel);
    rmSync(path.join(library, leftover));
    assert.equal((await store.rename(FROM, 'Places/Port.html', null)).id, 'wiki/Places/Port.html');
  });
}

// Rule: a rename never moves a sidecar or marks file through a link that leaves its folder.
for (const [what, folder] of [['marks file', '.neo/marks'], ['sidecar', '.neo/pages']] as const) {
  for (const end of ['source', 'destination'] as const) {
    test(`a rename is refused before anything moves when the ${what} ${end} is reached through a link that leaves ${folder}`, async (t) => {
      const { store, library, get, has } = fixture(t);
      const outside = tempDir(t, 'hoard-outside-');
      const linkAt = path.join(library, `${folder}/wiki/${end === 'source' ? 'People' : 'Places'}`);
      if (end === 'source') {
        rmSync(outside, { recursive: true });
        renameSync(linkAt, outside);
      }
      mkdirSync(path.dirname(linkAt), { recursive: true });
      symlinkSync(outside, linkAt, 'junction');
      const outsideBefore = readdirSync(outside).sort();
      assert.deepEqual(outsideBefore, end === 'source' ? ['Harbour.html.json'] : [], 'the link leads out and the fixture reached its state');
      const was = Object.fromEntries(['wiki/People/Harbour.html', 'wiki/Index.html'].map((rel) => [rel, get(rel)]));

      await assert.rejects(store.rename(FROM, 'Places/Port.html', null), (e: PageRefused) => e.code === 'unsafe');
      assert.equal(has('.neo/pages/.rename.json'), false, 'no note of a rename was written');
      assert.equal(has('wiki/Places/Port.html'), false, 'the page did not move');
      for (const [rel, text] of Object.entries(was)) assert.equal(get(rel), text, rel);
      assert.deepEqual(readdirSync(outside).sort(), outsideBefore, 'nothing moved into or out of the folder the link leads to');
    });
  }
}
