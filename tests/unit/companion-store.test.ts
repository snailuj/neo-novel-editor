// Rules for the librarian reading a chapter the writer has left:
// - each wiki page its new paragraphs name gets one librarian comment, on the first
//   mention, and the chapter is never told about that page again, however it answered;
// - aliases and a pantsing draft status come from the page's frontmatter;
// - the wiki book, a library with no wiki, and unchanged words give nothing;
// - a page the writer quieted is left out until they ask for it again, and a quiet file
//   that does not read is never taken for empty or written over;
// - a marks file that does not read is never written over;
// - two reads of one chapter at once flag a page once.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateHoardCompanionV1, validateHoardMarksV1 } from '../../src/generated/validators.cjs';
import { Companion, CompanionFileError } from '../../src/hoard/companion/store.ts';
import { locate } from '../../src/hoard/marks/anchor.ts';
import { MarkStore, sidecarPath } from '../../src/hoard/marks/store.ts';
import { WikiStore } from '../../src/hoard/wiki/store.ts';
import { tempDir } from './git-support.ts';

type T = { after(fn: () => void): void };

async function setup(t: T, seeded = true) {
  const library = tempDir(t);
  const vault = tempDir(t);
  const wrote: string[] = [];
  const lines: { level: string; message: string }[] = [];
  let n = 0;
  const now = () => new Date('2026-10-15T23:00:00.000Z');
  const newId = (prefix: string) => `${prefix}-t${(n++).toString().padStart(4, '0')}`;
  const log = (level: 'error' | 'warn' | 'info' | 'debug', message: string) => { lines.push({ level, message }); };
  const marks = new MarkStore({ library: () => library, now, newId, wrote: (name) => wrote.push(name), log });
  const wiki = new WikiStore({ library: () => library, now, newId, marks, log });
  if (seeded) {
    const page = (name: string, text: string) => {
      const file = path.join(vault, `${name}.md`);
      writeFileSync(file, text);
      return file;
    };
    await wiki.apply(wiki.sort([
      page('Kraken', '---\naliases: [the Deep One]\n---\nIt lives below.\n'),
      page('Whatif Dolphins', '---\ndraft_status: pantsing\n---\nWhat if.\n'),
      page('Harbour', 'The wall.\n'),
    ]), null);
  }
  const companion = new Companion({ library: () => library, marks, wiki: () => wiki.pages(), now, newId: () => newId('m'), wrote: (name) => wrote.push(name), log });
  const pageId = (title: string) => wiki.pages()!.pages.find((p) => p.title === title)!.chId;
  const marksOf = (chId: string) => {
    const data = JSON.parse(readFileSync(sidecarPath(library, 'book-a', chId), 'utf8'));
    assert.ok(validateHoardMarksV1(data));
    return data.marks;
  };
  return { library, wiki, companion, marks, marksOf, pageId, wrote, lines };
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

test('an alias from the frontmatter names its page, and a typed link is not a mention', async (t) => {
  const { companion, marksOf } = await setup(t);
  await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('[[Harbour]] and the deep one.') });
  assert.deepEqual(marksOf('c1').map((m: { thread: { body: string }[] }) => m.thread[0]!.body.split(':')[0]), ['[[Kraken|the deep one]]']);
});

test('the wiki book, a library with no wiki, and unchanged words give nothing', async (t) => {
  const { companion, wiki, lines } = await setup(t);
  const wikiId = wiki.pages()!.bookId;
  assert.deepEqual(await companion.read({ bookId: wikiId, chId: 'c1', before: '', after: html('The Kraken.') }), { added: 0 });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: html('The Kraken.'), after: html('The <b>Kraken</b>.') }), { added: 0 });
  const none = await setup(t, false);
  assert.deepEqual(await none.companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), { added: 0 });
  assert.ok(!lines.some((l) => l.level === 'error'));
});

test('a quieted page is left out until the writer asks for it again', async (t) => {
  const { companion, pageId, library, marksOf } = await setup(t);
  assert.deepEqual(companion.quiet(pageId('Kraken'), true), { quiet: [pageId('Kraken')] });
  const file = JSON.parse(readFileSync(path.join(library, '.neo', 'companion.json'), 'utf8'));
  assert.ok(validateHoardCompanionV1(file));
  assert.deepEqual(file.quiet[pageId('Kraken')], { title: 'Kraken', at: '2026-10-15T23:00:00.000Z' });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), { added: 0 });
  assert.deepEqual(companion.quiet(pageId('Kraken'), false), { quiet: [] });
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: html('The Kraken.'), after: html('The Kraken.', 'Kraken!') }), { added: 1 });
  assert.equal(marksOf('c1').length, 1);
  assert.throws(() => companion.quiet('no-such-page', true), RangeError);
});

test('a quiet file that does not read is never taken for empty or written over', async (t) => {
  const { companion, pageId, library, lines } = await setup(t);
  const file = path.join(library, '.neo', 'companion.json');
  writeFileSync(file, '{"version": 1, "quiet": ');
  await assert.rejects(companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), CompanionFileError);
  assert.throws(() => companion.quiet(pageId('Kraken'), true), CompanionFileError);
  assert.equal(readFileSync(file, 'utf8'), '{"version": 1, "quiet": ');
  assert.ok(lines.some((l) => l.level === 'error' && l.message.includes('companion.json')));
});

test('a marks file that does not read is never written over', async (t) => {
  const { companion, library } = await setup(t);
  const file = sidecarPath(library, 'book-a', 'c1');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'not json');
  assert.deepEqual(await companion.read({ bookId: 'book-a', chId: 'c1', before: '', after: html('The Kraken.') }), { added: 0 });
  assert.equal(readFileSync(file, 'utf8'), 'not json');
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
