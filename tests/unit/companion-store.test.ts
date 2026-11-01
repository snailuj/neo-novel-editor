// Rules for the librarian reading a chapter the writer has left:
// - each page, in either tree, that its new paragraphs name gets one librarian comment, on
//   the first mention, and the chapter is never told about that page again, however it
//   answered;
// - a wiki page wins over a source with the same title, and the pair is one entry;
// - aliases and a pantsing draft status come from the page's sidecar;
// - the wiki book while it exists, a library with no pages, and unchanged words give nothing;
// - a page the writer quieted, by its id, is left out until they ask for it again, across
//   reloads; a quiet file that does not read is never taken for empty or written over,
//   and a key that is not a page id is ignored and logged once;
// - a marks file that does not read is never written over;
// - two reads of one chapter at once flag a page once;
// - read while the writer is still typing, a name the caret is in or just after is left
//   for a later read, since the word may not be finished;
// - a page added after an earlier read is found by the next one.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateHoardCompanionV1, validateHoardMarksV1 } from '../../src/generated/validators.cjs';
import { Companion, CompanionFileError } from '../../src/hoard/companion/store.ts';
import { locate } from '../../src/hoard/marks/anchor.ts';
import { MarkStore, sidecarPath } from '../../src/hoard/marks/store.ts';
import { pagesLibrary } from './pages-support.ts';

type T = { after(fn: () => void): void };

const SIDECAR = (frontmatter: Record<string, unknown> | null) => `${JSON.stringify({
  version: 1,
  source: { path: '/synthetic/vault/page.md', name: 'page', sha256: '0'.repeat(64) },
  frontmatter,
  imported: '2026-10-15T22:00:00.000Z',
})}\n`;

async function setup(t: T, seeded = true) {
  const lib = pagesLibrary(t);
  const { library, store } = lib;
  const wrote: string[] = [];
  const lines: { level: string; message: string }[] = [];
  let n = 0;
  const now = () => new Date('2026-10-15T23:00:00.000Z');
  const newId = (prefix: string) => `${prefix}-t${(n++).toString().padStart(4, '0')}`;
  const log = (level: 'error' | 'warn' | 'info' | 'debug', message: string) => { lines.push({ level, message }); };
  const marks = new MarkStore({ library: () => library, now, newId, wrote: (name) => wrote.push(name), log });
  // a page file, with a sidecar when the frontmatter is given
  const page = (id: string, frontmatter?: Record<string, unknown> | null) => {
    lib.put(id, '<p>Words.</p>');
    if (frontmatter !== undefined) lib.put(`.neo/pages/${id}.json`, SIDECAR(frontmatter));
  };
  if (seeded) {
    page('wiki/Kraken.html', { aliases: ['the Deep One'] });
    page('wiki/Whatif Dolphins.html', { draft_status: 'pantsing' });
    page('wiki/Harbour.html');
  }
  let wikiBook: string | null = null;
  const companion = new Companion({ library: () => library, marks, pages: store, wikiBook: () => wikiBook, now, newId: () => newId('m'), wrote: (name) => wrote.push(name), log });
  const marksOf = (chId: string) => {
    const data = JSON.parse(readFileSync(sidecarPath(library, 'book-a', chId), 'utf8'));
    assert.ok(validateHoardMarksV1(data));
    return data.marks;
  };
  return { ...lib, library, companion, marks, marksOf, page, wrote, lines, wikiIs: (id: string | null) => { wikiBook = id; } };
}

const html = (...ps: string[]) => ps.map((p) => `<p>${p}</p>`).join('');

test('each page a new paragraph names gets one librarian comment, on its first mention', async (t) => {
  const { companion, marksOf, wrote } = await setup(t);
  const before = html('The harbour wall.');
  const after = html('The harbour wall.', 'Then the <i>Kraken</i> rose, and the kraken sank.', 'Dolphins, whatif dolphins.');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before, after }), { added: 2 });
  const marks = marksOf('c1');
  assert.deepEqual(marks.map((m: { created: { who: string }; thread: { who: string; body: string }[] }) => [m.created.who, m.thread[0]!.who, m.thread[0]!.body]), [
    ['librarian', 'librarian', '[[Kraken]]: matched as a bare name in your prose (a guess, not a link you typed).'],
    ['librarian', 'librarian', '[[whatif dolphins]]: an offering from the pantsing shelf; matched as a bare name in your prose (a guess, not a link you typed).'],
  ]);
  assert.deepEqual(locate(['The harbour wall.', 'Then the Kraken rose, and the kraken sank.', 'Dolphins, whatif dolphins.'], marks[0].anchor), { pIdx: 1, off: 9, len: 6 });
  assert.ok(wrote.includes('.neo'));
});

test('a chapter is told about a page once, even once its comment is resolved', async (t) => {
  const { companion, marks, marksOf } = await setup(t);
  await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') });
  const [first] = marksOf('c1');
  await marks.setState({ bookId: 'book-a', chId: 'c1', markId: first.id, state: 'resolved' }, 'author');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: html('The Kraken.'), after: html('The Kraken.', 'The kraken again.') }), { added: 0 });
  assert.equal(marksOf('c1').length, 1);
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c2', before: '', after: html('The kraken in another chapter.') }), { added: 1 });
});

test('an alias from a page sidecar is matched, and a typed link is not a mention', async (t) => {
  const { companion, marksOf } = await setup(t);
  await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('[[Harbour]] and the deep one.') });
  assert.deepEqual(marksOf('c1').map((m: { thread: { body: string }[] }) => m.thread[0]!.body.split(':')[0]), ['[[Kraken|the deep one]]']);
});

test('the wiki book while it exists, a library with no pages, and unchanged words give nothing', async (t) => {
  const { companion, wikiIs, lines } = await setup(t);
  wikiIs('book-wiki');
  assert.deepEqual(await companion.read({ bookId: 'book-wiki', chId: 'c1', before: '', after: html('The Kraken.') }), { added: 0 });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: html('The Kraken.'), after: html('The <b>Kraken</b>.') }), { added: 0 });
  const none = await setup(t, false);
  assert.deepEqual(await none.companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), { added: 0 });
  assert.ok(!lines.some((l) => l.level === 'error'));
});

test('a mention of a source page\'s title in a saved chapter is found and names the page id', async (t) => {
  const { companion, page, marksOf } = await setup(t);
  page('sources/Notes/Lighthouse.html');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The lighthouse stood.') }), { added: 1 });
  const [mark] = marksOf('c1');
  assert.equal(mark.thread[0].body, '[[lighthouse]]: matched as a bare name in your prose (a guess, not a link you typed).');
  // the chapter is told once, and the id is what quieting the page is keyed by
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: html('The lighthouse stood.'), after: html('The lighthouse stood.', 'Lighthouse again.') }), { added: 0 });
  assert.deepEqual(companion.quiet('sources/Notes/Lighthouse.html', true), { quiet: ['sources/Notes/Lighthouse.html'] });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c2', before: '', after: html('The lighthouse.') }), { added: 0 });
});

test('a wiki page wins over a source with the same title, and the pair is one entry', async (t) => {
  const { companion, page, marksOf } = await setup(t);
  page('sources/Notes/Kraken.html', { aliases: ['the Deep One', 'Sea Beast'] });
  page('sources/Ledger.html', { aliases: ['Harbour'] });
  // a source titled as a wiki page's alias does not take the name from it
  page('sources/The Deep One.html');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken and the deep one and the sea beast at the harbour.') }), { added: 2 });
  assert.equal(marksOf('c1').length, 2);
  // quieting the wiki page is enough: no source page is left to flag the name
  companion.quiet('wiki/Kraken.html', true);
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c2', before: '', after: html('The Kraken, the deep one.') }), { added: 0 });
});

test('a draft or pantsing page behaves as before, in either tree', async (t) => {
  const { companion, page, marksOf } = await setup(t);
  page('sources/Maybe Moths.html', { draft_status: 'pantsing' });
  await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('Whatif dolphins and maybe moths.') });
  const bodies = marksOf('c1').map((m: { thread: { body: string }[] }) => m.thread[0]!.body);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((b: string) => b.includes('an offering from the pantsing shelf')));
});

test('quieting a page by id silences it across reloads', async (t) => {
  const { companion, library, store, marks, marksOf, wrote, lines } = await setup(t);
  assert.deepEqual(companion.quiet('wiki/Kraken.html', true), { quiet: ['wiki/Kraken.html'] });
  const file = JSON.parse(readFileSync(path.join(library, '.neo', 'companion.json'), 'utf8'));
  assert.ok(validateHoardCompanionV1(file));
  assert.deepEqual(file.quiet['wiki/Kraken.html'], { title: 'Kraken', at: '2026-10-15T23:00:00.000Z' });
  // a second companion over the same library: nothing is held in memory
  const reloaded = new Companion({ library: () => library, marks, pages: store, wikiBook: () => null, log: (level, message) => { lines.push({ level, message }); }, wrote: (n) => wrote.push(n) });
  assert.deepEqual(reloaded.state(), { quiet: ['wiki/Kraken.html'] });
  assert.deepEqual(await reloaded.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), { added: 0 });
  assert.deepEqual(companion.quiet('wiki/Kraken.html', false), { quiet: [] });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: html('The Kraken.'), after: html('The Kraken.', 'Kraken!') }), { added: 1 });
  assert.equal(marksOf('c1').length, 1);
  assert.throws(() => companion.quiet('wiki/No Such Page.html', true), RangeError);
  assert.throws(() => companion.quiet('no-such-page', true), RangeError);
});

test('a quiet key that is not a page id is ignored and logged once', async (t) => {
  const { companion, library, lines } = await setup(t);
  mkdirSync(path.join(library, '.neo'), { recursive: true });
  writeFileSync(path.join(library, '.neo', 'companion.json'), `${JSON.stringify({ version: 1, quiet: { 'ch-old': { title: 'Kraken', at: '2026-10-15T23:00:00.000Z' } } })}\n`);
  assert.deepEqual(companion.state(), { quiet: [] });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), { added: 1 });
  assert.equal(lines.filter((l) => l.message.includes('ch-old')).length, 1);
  assert.deepEqual(companion.quiet('wiki/Harbour.html', true), { quiet: ['wiki/Harbour.html'] });
});

test('a quiet file that does not read is never taken for empty or written over', async (t) => {
  const { companion, library, lines } = await setup(t);
  const file = path.join(library, '.neo', 'companion.json');
  writeFileSync(file, '{"version": 1, "quiet": ');
  await assert.rejects(companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), CompanionFileError);
  assert.throws(() => companion.quiet('wiki/Kraken.html', true), CompanionFileError);
  assert.equal(readFileSync(file, 'utf8'), '{"version": 1, "quiet": ');
  assert.ok(lines.some((l) => l.level === 'error' && l.message.includes('companion.json')));
});

test('a marks file that does not read is never written over, and is read again only once it changes', async (t) => {
  const { companion, library, lines } = await setup(t);
  const file = sidecarPath(library, 'book-a', 'c1');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'not json');
  const read = () => companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') });
  assert.deepEqual(await read(), { added: 0 });
  assert.deepEqual(await read(), { added: 0 });
  assert.equal(readFileSync(file, 'utf8'), 'not json');
  assert.equal(lines.filter((l) => l.message.includes('does not read')).length, 1);
  writeFileSync(file, '{"version": 1, "marks": []}\n');
  assert.deepEqual(await read(), { added: 1 });
});

test('two reads of one chapter at once flag a page once', async (t) => {
  const { companion, marksOf } = await setup(t);
  const after = html('The Kraken.');
  const answers = await Promise.all([
    companion.read({ bookId: 'book-a', chId: 'c1', before: '', after }),
    companion.read({ bookId: 'book-a', chId: 'c1', before: '', after }),
  ]);
  assert.deepEqual(answers.map((a) => a.added).sort(), [0, 1]);
  assert.equal(marksOf('c1').length, 1);
});

test('a name the caret is in or just after is left for a later read, as the word may not be finished', async (t) => {
  const { companion, marksOf } = await setup(t);
  const after = html('The tide.', 'Then the Kraken');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after, caret: { pIdx: 1, off: 15 } }), { added: 0 });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after, caret: { pIdx: 1, off: 11 } }), { added: 0 });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after, caret: { pIdx: 0, off: 9 } }), { added: 1 });
  assert.equal(marksOf('c1').length, 1);
});

test('a name before the caret, with the word finished, is read at once', async (t) => {
  const { companion } = await setup(t);
  const after = html('Then the Kraken rose');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after, caret: { pIdx: 0, off: 20 } }), { added: 1 });
});

test('a page added after an earlier read is found by the next one', async (t) => {
  const { companion, page } = await setup(t);
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The lighthouse.') }), { added: 0 });
  page('sources/Lighthouse.html');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The lighthouse.') }), { added: 1 });
});
