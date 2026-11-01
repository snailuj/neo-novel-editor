// Rules for the librarian's watcher in the window, over a stub of the host's API:
// - Stop Flagging This Page and Flag This Page Again act on the page the librarian's
//   comment links to, and send its page id, whichever tree it is in;
// - a title in both trees is the wiki page's id, as a link resolves it;
// - a chapter of the Wiki book is never handed over, while that book exists.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { startCompanion } from '../../src/hoard/companion/window.ts';

type Handler = (payload: never) => unknown;

const GUESS = 'matched as a bare name in your prose (a guess, not a link you typed).';

const finding = (target: string): Mark => ({
  id: 'm1',
  kind: 'comment',
  state: 'open',
  anchor: { exact: target, prefix: '', suffix: '', pIdx: 0, off: 0, len: target.length, commit: null },
  created: { who: 'librarian', at: '2026-10-15T23:00:00.000Z' },
  thread: [{ who: 'librarian', at: '2026-10-15T23:00:00.000Z', body: `[[${target}]]: ${GUESS}` }],
} as unknown as Mark);

function setup(pages: { id: string; tree: 'wiki' | 'sources'; title: string }[], target: string) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, () => unknown>();
  const sent: { channel: string; payload: unknown }[] = [];
  const said: string[] = [];
  const neo = {
    on: (name: string, fn: Handler) => { handlers.set(name, fn); },
    addCommand: (name: string, fn: () => unknown) => { commands.set(name, fn); },
    status: (text: string) => { said.push(text); },
    book: () => ({ id: 'book-a' }),
    invoke: async (channel: string, payload?: unknown) => {
      sent.push({ channel, payload });
      return channel === 'companion.read' ? { added: 0 } : {};
    },
  };
  const mark = finding(target);
  const view = {
    state: () => ({ bookId: 'book-a', marks: { c1: [mark] }, active: 'm1', here: { chId: 'c1' } }),
    relist: async () => {},
  };
  const watcher = startCompanion(neo as never, { marks: view, wikiBook: () => 'book-wiki', pages: async () => pages });
  return { handlers, commands, sent, said, watcher };
}

test('Stop Flagging and Flag Again send the id of the page the comment links to', async () => {
  const { commands, sent } = setup([
    { id: 'sources/Notes/Lighthouse.html', tree: 'sources', title: 'Lighthouse' },
    { id: 'wiki/Kraken.html', tree: 'wiki', title: 'Kraken' },
  ], 'Lighthouse');
  await commands.get('stop-flagging')!();
  await commands.get('flag-again')!();
  assert.deepEqual(sent.filter((s) => s.channel === 'companion.quiet').map((s) => s.payload), [
    { page: 'sources/Notes/Lighthouse.html', quiet: true },
    { page: 'sources/Notes/Lighthouse.html', quiet: false },
  ]);
});

test('a title in both trees is the wiki page\'s id, as a link resolves it', async () => {
  const { commands, sent } = setup([
    { id: 'sources/Kraken.html', tree: 'sources', title: 'Kraken' },
    { id: 'wiki/Kraken.html', tree: 'wiki', title: 'Kraken' },
  ], 'Kraken');
  await commands.get('stop-flagging')!();
  assert.deepEqual(sent.find((s) => s.channel === 'companion.quiet')?.payload, { page: 'wiki/Kraken.html', quiet: true });
});

test('a comment that links no page says so and changes nothing', async () => {
  const { commands, sent, said } = setup([{ id: 'wiki/Kraken.html', tree: 'wiki', title: 'Kraken' }], 'Nothing Here');
  await commands.get('stop-flagging')!();
  assert.equal(sent.some((s) => s.channel === 'companion.quiet'), false);
  assert.match(said.at(-1) ?? '', /Put the caret in one of the librarian's comments/);
});

test('a chapter of the Wiki book is never handed over, while that book exists', async () => {
  const { handlers, sent, watcher } = setup([], 'Kraken');
  const saved = handlers.get('chapter-saved') as (e: { bookId: string; chId: string; html: string; previous: string | null }) => void;
  saved({ bookId: 'book-wiki', chId: 'c1', html: '<p>The Kraken.</p>', previous: '' });
  saved({ bookId: 'book-a', chId: 'c1', html: '<p>The Kraken.</p>', previous: '' });
  await watcher.settled();
  assert.deepEqual(sent.filter((s) => s.channel === 'companion.read').map((s) => (s.payload as { bookId: string }).bookId), ['book-a']);
});
