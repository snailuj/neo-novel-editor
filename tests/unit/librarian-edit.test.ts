// Rule: the chapter a librarian edit changes is held from before the author's commit
// until after the librarian's, however the edit ends, so no typing of the writer's can
// land between the two; an edit the main half refuses never runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { librarianEdits } from '../../src/hoard/git/librarian.ts';
import { Holds } from '../../src/hoard/holds.ts';

function fakeNeo(options: { begin?: (payload: unknown) => unknown; end?: (payload: unknown) => unknown } = {}) {
  const events: string[] = [];
  let html = '<p>One.</p>';
  const neo = {
    book: () => ({ id: 'book-fox-1', chapterOrder: ['c1'] }),
    chapter: (chId: string) => (chId === 'c1' ? { id: 'c1', html, paragraphs: [] } : null),
    hold: (chIds: readonly string[]) => { events.push(`hold ${chIds.join(',')}`); },
    async invoke(channel: string, payload?: unknown) {
      events.push(`${channel} ${JSON.stringify(payload)}`);
      if (channel === 'git.librarian-begin') return options.begin ? options.begin(payload) : { pair: 'p1' };
      if (channel === 'git.librarian-end') return options.end ? options.end(payload) : { before: 'b', after: 'a' };
      throw new Error(`no channel ${channel}`);
    },
    async replace(place: { chId: string }, _expected: string, newText: string) {
      events.push(`replace ${place.chId}`);
      html = `<p>${newText}</p>`;
      return { ok: true as const };
    },
  };
  const edits = librarianEdits(neo, new Holds((ids) => neo.hold(ids)));
  return { neo, edits, events, edit: (text: string) => { html = text; } };
}

test('the chapter is held from before the author\'s commit until after the librarian\'s', async () => {
  const { edits, events, edit } = fakeNeo();
  const done = await edits.edit('c1', async () => {
    events.push('apply');
    edit('<p>Amended.</p>');
    return 3;
  });
  assert.deepEqual(done, { ok: true, result: 3, before: 'b', after: 'a' });
  assert.deepEqual(events, [
    'hold c1',
    'git.librarian-begin {"bookId":"book-fox-1","chId":"c1","html":"<p>One.</p>"}',
    'apply',
    'git.librarian-end {"pair":"p1","html":"<p>Amended.</p>"}',
    'hold ',
  ]);
});

test('an edit the main half refuses never runs, and the chapter is let go', async () => {
  const { edits, events } = fakeNeo({ begin: () => ({ refused: 'unsaved' }) });
  let ran = false;
  assert.deepEqual(await edits.edit('c1', async () => { ran = true; }), { ok: false, reason: 'unsaved' });
  assert.equal(ran, false);
  assert.equal(events.at(-1), 'hold ');
});

test('an author commit that fails stops the edit, and the chapter is let go', async () => {
  const { edits, events } = fakeNeo({ begin: () => { throw new Error('no identity'); } });
  let ran = false;
  await assert.rejects(edits.edit('c1', async () => { ran = true; }), /no identity/);
  assert.equal(ran, false);
  assert.equal(events.at(-1), 'hold ');
});

test('an edit that fails still ends the pair with the chapter as it stands, then lets it go', async () => {
  const { edits, events, edit } = fakeNeo();
  await assert.rejects(edits.edit('c1', async () => {
    edit('<p>Half.</p>');
    throw new Error('broke');
  }), /broke/);
  assert.deepEqual(events.slice(-2), ['git.librarian-end {"pair":"p1","html":"<p>Half.</p>"}', 'hold ']);
});

test('an edit the gate refuses says why, and the chapter is let go', async () => {
  const findings = [{ path: 'book-fox-1/chapters/c1.html', rule: 'Block-Ids-Citable', message: "block id 'b 1' cannot be cited" }];
  const { edits, events, edit } = fakeNeo({ end: () => ({ refused: findings }) });
  const done = await edits.edit('c1', async () => { edit('<p data-block="b 1">Amended.</p>'); });
  assert.deepEqual(done, { ok: false, reason: 'refused', findings });
  assert.equal(events.at(-1), 'hold ');
});

test('a chapter not in the open book is not held and makes no pair', async () => {
  const { edits, events } = fakeNeo();
  assert.deepEqual(await edits.edit('c9', async () => {}), { ok: false, reason: 'missing' });
  assert.deepEqual(events, []);
});

test('replace runs the host\'s replace inside the pair', async () => {
  const { edits, events } = fakeNeo();
  const done = await edits.replace({ chId: 'c1', pIdx: 0, off: 0, len: 4 }, 'One.', 'Uno.');
  assert.deepEqual(done, { ok: true, result: { ok: true }, before: 'b', after: 'a' });
  assert.deepEqual(events.slice(1, 4).map((e) => e.split(' ')[0]), ['git.librarian-begin', 'replace', 'git.librarian-end']);
  assert.match(events[3], /<p>Uno\.<\/p>/);
});

// Rule: a chapter stays held while any of hoard's reasons holds it.
test('holds gather: letting one go keeps the others, and letting go twice changes nothing', () => {
  const sent: string[][] = [];
  const holds = new Holds((ids) => sent.push([...ids]));
  const a = holds.hold(['c1']);
  const b = holds.hold(['c1', 'c2']);
  a();
  a();
  b();
  assert.deepEqual(sent, [['c1'], ['c1', 'c2'], ['c1', 'c2'], []]);
});
