// Rules: the page store lists both trees' .html files without reading a body; a write
// lands only while the file still holds what the caller read; a title is taken once per
// tree; and every refusal is logged. Pages are files: the file name is the title.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { PageRefused } from '../../src/hoard/pages/identity.ts';
import { PageStore, type PageEntry } from '../../src/hoard/pages/store.ts';
import { tempDir } from './git-support.ts';
import { pagesLibrary } from './pages-support.ts';

test('list returns both trees\' .html files with their facts, and no body', async (t) => {
  const { store, put, library } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>Tide.</p>');
  put('wiki/People/Novin\'a.html', '<p>x</p>');
  put('sources/Moon.html', '<p>Moon.</p>');
  put('wiki/notes.md', 'not a page');
  put('wiki/.hidden/Secret.html', '<p>hidden</p>');
  put('sources/.git/x.html', '<p>hidden</p>');
  put('elsewhere/Stray.html', '<p>outside both trees</p>');
  const first = statSync(path.join(library, 'wiki/Tide.html'));

  const pages = await store.list();
  assert.deepEqual(pages.map((p) => p.id), ['sources/Moon.html', 'wiki/People/Novin\'a.html', 'wiki/Tide.html']);
  const tide = pages.find((p) => p.id === 'wiki/Tide.html')!;
  assert.deepEqual(Object.keys(tide).sort(), ['id', 'mtime', 'path', 'size', 'title', 'tree']);
  assert.deepEqual({ tree: tide.tree, path: tide.path, title: tide.title, size: tide.size, mtime: tide.mtime },
    { tree: 'wiki', path: 'Tide.html', title: 'Tide', size: 12, mtime: first.mtimeMs });
});

test('list of a library with neither folder is empty, and a symlinked folder is not followed', async (t) => {
  const { store, library, put } = pagesLibrary(t);
  assert.deepEqual(await store.list(), []);
  put('outside/Leak.html', '<p>x</p>');
  mkdirSync(path.join(library, 'wiki'));
  symlinkSync(path.join(library, 'outside'), path.join(library, 'wiki', 'link'), 'junction');
  assert.deepEqual(await store.list(), []);
});

test('entries yields one page at a time, so a caller can stop early', async (t) => {
  const { store, put } = pagesLibrary(t);
  for (const n of ['A', 'B', 'C']) put(`wiki/${n}.html`, '<p>x</p>');
  const seen: string[] = [];
  for await (const page of store.entries()) {
    seen.push(page.id);
    break;
  }
  assert.equal(seen.length, 1);
});

test('read gives the page\'s file whole, null for a page that is not there, and refuses an id out of its tree', async (t) => {
  const { store, put, logged } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>Tide.</p>');
  assert.deepEqual(await store.read('wiki/Tide.html'), { id: 'wiki/Tide.html', tree: 'wiki', path: 'Tide.html', title: 'Tide', html: '<p>Tide.</p>' });
  assert.equal(await store.read('wiki/Nope.html'), null);
  await assert.rejects(store.read('wiki/../library.json'), PageRefused);
  await assert.rejects(store.read('/etc/passwd'), PageRefused);
  assert.equal(logged('pages.refused').length, 2);
});

test('a write lands only while the file holds what the caller read', async (t) => {
  const { store, put, get, logged } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>one</p>');
  assert.deepEqual(await store.write('wiki/Tide.html', '<p>one</p>', '<p>two</p>'), { ok: true });
  assert.equal(get('wiki/Tide.html'), '<p>two</p>');

  assert.deepEqual(await store.write('wiki/Tide.html', '<p>one</p>', '<p>three</p>'), { ok: false, reason: 'stale' });
  assert.equal(get('wiki/Tide.html'), '<p>two</p>', 'a stale write changes nothing');
  assert.deepEqual(await store.write('wiki/Gone.html', 'x', 'y'), { ok: false, reason: 'missing' });
  assert.equal(logged('pages.write').length, 1);
  assert.equal(logged('pages.write.refused').length, 2);
});

test('a write that changes nothing leaves the file alone', async (t) => {
  const { store, put, library } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>one</p>');
  const before = statSync(path.join(library, 'wiki/Tide.html')).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await store.write('wiki/Tide.html', '<p>one</p>', '<p>one</p>'), { ok: true });
  assert.equal(statSync(path.join(library, 'wiki/Tide.html')).mtimeMs, before);
});

test('create writes a new page and its folders, and refuses a file that is there', async (t) => {
  const { store, get, logged } = pagesLibrary(t);
  const made = await store.create('wiki', 'People/Novin\'a.html', '<p>x</p>');
  assert.equal(made.id, 'wiki/People/Novin\'a.html');
  assert.equal(get('wiki/People/Novin\'a.html'), '<p>x</p>');
  await assert.rejects(store.create('wiki', 'People/Novin\'a.html', '<p>y</p>'), (e: PageRefused) => e.code === 'taken');
  assert.equal(get('wiki/People/Novin\'a.html'), '<p>x</p>');
  assert.equal(logged('pages.create').length, 1);
});

test('a title is taken once per tree, folded as links fold it, wherever its folder', async (t) => {
  const { store, put, has, logged } = pagesLibrary(t);
  put('wiki/People/Tide.html', '<p>x</p>');
  await assert.rejects(store.create('wiki', 'Places/TIDE.html', 'x'), (e: PageRefused) => e.code === 'taken');
  assert.equal(has('wiki/Places/TIDE.html'), false);
  await store.create('sources', 'Tide.html', '<p>a source may share it</p>');
  assert.equal(has('sources/Tide.html'), true);
  assert.equal(logged('pages.refused').length, 1);
});

test('a title that no [[link]] could name is refused, and so is a path out of the tree', async (t) => {
  const { store, has, logged } = pagesLibrary(t);
  for (const bad of ['A#1.html', 'A|B.html', 'A^1.html', 'A[x].html', ' .html']) {
    await assert.rejects(store.create('wiki', bad, 'x'), (e: PageRefused) => e.code === 'title' || e.code === 'unsafe', bad);
  }
  for (const bad of ['../Out.html', '/abs/Out.html', 'a\\b.html', '.git/Out.html']) {
    await assert.rejects(store.create('wiki', bad, 'x'), (e: PageRefused) => e.code === 'unsafe', bad);
  }
  await assert.rejects(store.create('nowhere' as 'wiki', 'A.html', 'x'), PageRefused);
  assert.equal(has('Out.html'), false);
  assert.equal(logged('pages.refused').length, 10);
});

test('resolve gives the wiki page over a source with the same title', async (t) => {
  const { store, put } = pagesLibrary(t);
  put('sources/Tide.html', '<p>s</p>');
  put('wiki/Tide.html', '<p>w</p>');
  put('sources/Moon.html', '<p>m</p>');
  assert.equal((await store.resolve('tide'))?.id, 'wiki/Tide.html');
  assert.equal((await store.resolve('Moon'))?.id, 'sources/Moon.html');
  assert.equal(await store.resolve('Sun'), undefined);
});

test('list and the others log what they did, and list logs its time', async (t) => {
  const { store, put, logged } = pagesLibrary(t);
  put('wiki/Tide.html', '<p>x</p>');
  await store.list();
  const [line] = logged('pages.list');
  assert.ok(line);
  const data = line.data as { pages: number; ms: number };
  assert.equal(data.pages, 1);
  assert.equal(typeof data.ms, 'number');
});

// Rule: the titles are walked from disk once, then kept by create and rename, and walked
// again only by list(), so a thousand creates cost one walk and not a thousand.
test('create, resolve and rename walk the trees once between lists, and list picks up files that arrived', async (t) => {
  let walks = 0;
  class Counting extends PageStore {
    override async *entries() {
      walks++;
      yield* super.entries();
    }
  }
  const { library, put, has } = pagesLibrary(t);
  const store = new Counting({ library: () => library, log: () => {} });
  put('wiki/Tide.html', '<p>x</p>');
  for (let i = 0; i < 30; i++) await store.create('wiki', `Folder/Page ${i}.html`, '<p>x</p>');
  assert.equal((await store.resolve('page 7'))?.id, 'wiki/Folder/Page 7.html', 'a created page resolves');
  await assert.rejects(store.create('wiki', 'Else/TIDE.html', 'x'), (e: PageRefused) => e.code === 'taken');
  await store.rename('wiki/Folder/Page 3.html', 'Moved.html', null);
  assert.equal((await store.resolve('Moved'))?.id, 'wiki/Moved.html', 'a renamed page resolves at its new title');
  assert.equal(await store.resolve('Page 3'), undefined, 'and not at its old one');
  await store.create('wiki', 'Page 3.html', '<p>the old title is free</p>');
  // create and resolve walk once; a rename walks again only for the files that hold links
  assert.equal(walks, 2, `walked ${walks} times`);

  put('wiki/Synced/Arrived.html', '<p>from another device</p>');
  await assert.rejects(store.create('wiki', 'Synced/Arrived.html', 'x'), (e: PageRefused) => e.code === 'taken', 'the file on disk is still checked');
  await store.list();
  await assert.rejects(store.create('wiki', 'Other/arrived.html', 'x'), (e: PageRefused) => e.code === 'taken', 'list took in the arrived title');
  assert.equal(has('wiki/Other/arrived.html'), false);
});

// Rule: no request reaches a file whose real path is outside its tree, whatever link leads there.
test('a path through a symlinked folder or to a symlinked file is refused for every request', async (t) => {
  const { store, library, put, get, has, logged } = pagesLibrary(t);
  put('outside/Leak.html', '<p>secret</p>');
  put('wiki/Tide.html', '<p>t</p>');
  symlinkSync(path.join(library, 'outside'), path.join(library, 'wiki', 'link'), 'junction');
  symlinkSync(path.join(library, 'outside', 'Leak.html'), path.join(library, 'wiki', 'Alias.html'));
  assert.equal(get('wiki/link/Leak.html'), '<p>secret</p>', 'the link leads out of the tree');
  const unsafe = (e: PageRefused) => e.code === 'unsafe';

  await assert.rejects(store.read('wiki/link/Leak.html'), unsafe);
  await assert.rejects(store.read('wiki/Alias.html'), unsafe);
  await assert.rejects(store.write('wiki/link/Leak.html', '<p>secret</p>', '<p>changed</p>'), unsafe);
  await assert.rejects(store.create('wiki', 'link/New.html', '<p>n</p>'), unsafe);
  await assert.rejects(store.create('wiki', 'link/deeper/New.html', '<p>n</p>'), unsafe);
  await assert.rejects(store.rename('wiki/Tide.html', 'link/Tide.html', null), unsafe);
  await assert.rejects(store.rename('wiki/link/Leak.html', 'Leak.html', null), unsafe);
  symlinkSync(path.join(library, 'outside', 'Gone.html'), path.join(library, 'wiki', 'Gone.html'));
  await assert.rejects(store.create('wiki', 'Gone.html', '<p>g</p>'), unsafe, 'a link that leads nowhere yet');
  assert.equal(get('outside/Leak.html'), '<p>secret</p>');
  assert.equal(has('outside/New.html') || has('outside/deeper') || has('outside/Tide.html') || has('outside/Gone.html'), false, 'nothing was written outside');
  assert.equal(has('wiki/Tide.html'), true);
  assert.equal(logged('pages.refused').length, 8);
  assert.deepEqual((await store.list()).map((p) => p.id), ['wiki/Tide.html'], 'list follows neither link');
});

// A store whose next walk, once held, takes the library as it is and then waits to answer.
function heldStore(t: TestContext) {
  const { library, log, put } = pagesLibrary(t);
  let gate: Promise<void> | null = null;
  let walked = () => {};
  class Held extends PageStore {
    override async *entries(): AsyncGenerator<PageEntry> {
      const wait = gate;
      gate = null;
      const seen: PageEntry[] = [];
      for await (const p of super.entries()) seen.push(p);
      if (wait) {
        walked();
        await wait;
      }
      yield* seen;
    }
  }
  const holdNextWalk = () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const done = new Promise<void>((resolve) => { walked = resolve; });
    return { walked: done, release: () => release() };
  };
  return { store: new Held({ library: () => library, log }), put, holdNextWalk };
}

// Rule: a list whose walk began before a create, a rename or a write finished does not put
// its titles in place of the index the change kept, so a title made meanwhile stays taken.
test('a list that walked the trees before a change does not put back titles from before it', async (t) => {
  const { store, holdNextWalk } = heldStore(t);
  await store.create('wiki', 'Harbour.html', '<p>x</p>');
  const held = holdNextWalk();
  const listing = store.list();
  await held.walked;
  await store.create('wiki', 'Places/Quay.html', '<p>x</p>');
  held.release();
  assert.deepEqual((await listing).map((p) => p.id), ['wiki/Harbour.html'], 'the list itself is from before the create');
  await assert.rejects(store.create('wiki', 'Docks/quay.html', '<p>x</p>'), (e: PageRefused) => e.code === 'taken');
});

// Rule: a list that keeps the index it found (a change ran beside it) still leaves it to be
// walked again before the next title is checked, so a page that came in by sync, which only
// a walk sees, keeps its title taken, for a create and for a rename alike.
const asks = {
  create: (store: PageStore) => store.create('wiki', 'Docks/tide.html', '<p>x</p>'),
  rename: (store: PageStore) => store.rename('wiki/Harbour.html', 'Other/TIDE.html', null),
};
for (const [name, ask] of Object.entries(asks)) {
  test(`a page that came by sync stays taken though the list that saw it was set aside (${name})`, async (t) => {
    const { store, put, holdNextWalk } = heldStore(t);
    await store.create('wiki', 'Harbour.html', '<p>x</p>');
    put('wiki/Tide.html', '<p>synced</p>');
    const held = holdNextWalk();
    const listing = store.list();
    await held.walked;
    await store.create('wiki', 'Places/Quay.html', '<p>x</p>');
    held.release();
    assert.deepEqual((await listing).map((p) => p.id), ['wiki/Harbour.html', 'wiki/Tide.html'], 'the list saw the synced page');
    await assert.rejects(ask(store), (e: PageRefused) => e.code === 'taken');
  });
}

// Rule: a page tree that is itself a link out of the library is refused for every request and not listed.
for (const tree of ['wiki', 'sources'] as const) {
  test(`${tree}/ is refused for every request, logged and not listed, when the folder is a link that leaves the library`, async (t) => {
    const { store, library, put, has, logged, lines } = pagesLibrary(t);
    const outside = tempDir(t, 'hoard-outside-');
    writeFileSync(path.join(outside, 'Leak.html'), '<p>secret</p>');
    symlinkSync(outside, path.join(library, tree), 'junction');
    assert.ok(has(`${tree}/Leak.html`), 'the folder leads out and the fixture reached its state');
    const unsafe = (e: PageRefused) => e.code === 'unsafe';

    await assert.rejects(store.read(`${tree}/Leak.html`), unsafe);
    await assert.rejects(store.write(`${tree}/Leak.html`, '<p>secret</p>', '<p>changed</p>'), unsafe);
    await assert.rejects(store.create(tree, 'New.html', '<p>n</p>'), unsafe);
    await assert.rejects(store.rename(`${tree}/Leak.html`, 'Moved.html', null), unsafe);
    assert.deepEqual(readdirSync(outside), ['Leak.html'], 'nothing was written where the link leads');
    assert.equal(readFileSync(path.join(outside, 'Leak.html'), 'utf8'), '<p>secret</p>');
    assert.equal(logged('pages.refused').length, 4);
    // the other tree is still served
    const other = tree === 'wiki' ? 'sources' : 'wiki';
    put(`${other}/Moon.html`, '<p>m</p>');
    assert.equal((await store.read(`${other}/Moon.html`))?.html, '<p>m</p>');
    assert.deepEqual((await store.list()).map((p) => p.id), [`${other}/Moon.html`], 'what the link leads to is not listed');
    assert.ok(lines.some((l) => l.level === 'warn' && l.message.includes(`${tree} is a link that leads out of the library`)), 'and the listing says why');
  });
}

// Rule: a page id whose parent segment is a file gets a clean refusal, not a raw error.
test('a page id below a page file is refused for every request, and nothing is made', async (t) => {
  const { store, put, has, get, logged } = pagesLibrary(t);
  put('wiki/Foo.html', '<p>foo</p>');
  put('wiki/Deep/Bar.html', '<p>bar</p>');
  put('wiki/Deep/Baz.html', '<p>baz</p>');
  const unsafe = (e: PageRefused) => e.code === 'unsafe' && /Foo\.html is a file/.test(e.message);
  await assert.rejects(store.read('wiki/Foo.html/Bar.html'), unsafe);
  await assert.rejects(store.write('wiki/Foo.html/Bar.html', 'a', 'b'), unsafe);
  await assert.rejects(store.create('wiki', 'Foo.html/Bar.html', '<p>n</p>'), unsafe);
  await assert.rejects(store.create('wiki', 'Deep/Baz.html/Qux.html', '<p>n</p>'), (e: PageRefused) => e.code === 'unsafe' && /Deep\/Baz\.html is a file/.test(e.message));
  await assert.rejects(store.rename('wiki/Foo.html/Bar.html', 'Z.html', null), unsafe);
  await assert.rejects(store.rename('wiki/Deep/Bar.html', 'Foo.html/Z.html', null), unsafe);
  assert.equal(get('wiki/Foo.html'), '<p>foo</p>');
  assert.equal(has('wiki/Deep/Bar.html'), true);
  assert.equal(logged('pages.refused').length, 6);
});
