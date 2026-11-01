// The Pages tree in the wiki pane, as data: folders and pages from pages.list, the rows
// drawn, the paths a rename, a move or a new page asks for, and the row editor's states.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tree } from '../../src/hoard/pages/identity.ts';
import { buildTree, CLOSED, explain, foldersIn, judge, newPageHtml, step, visibleRows, type Editor, type EditorEvent } from '../../src/hoard/wiki/tree.ts';

const page = (id: string) => {
  const tree = id.slice(0, id.indexOf('/')) as Tree;
  const path = id.slice(id.indexOf('/') + 1);
  return { id, tree, path, title: path.slice(path.lastIndexOf('/') + 1, -'.html'.length) };
};

const shape = (rows: ReturnType<typeof visibleRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'folder' ? `${r.name}/` : r.name}`);

// Rule: each tree lists its folders before its pages, folders by name and pages by title,
// in the order a reader expects (case aside, numbers by value), and both trees are there
// even with no pages in them.
test('folders come first, then pages by title, in each tree', () => {
  const roots = buildTree([
    'wiki/page 10.html', 'wiki/Page 2.html', 'wiki/people/Zed.html', 'wiki/Places/Vell.html',
    'wiki/people/ada.html', 'wiki/People notes.html', 'wiki/places/inner/Deep.html',
  ].map(page));
  assert.deepEqual(roots.map((r) => [r.key, r.name]), [['wiki', 'wiki'], ['sources', 'sources']]);
  const all = new Set(['wiki', 'sources', 'wiki/people', 'wiki/Places', 'wiki/places', 'wiki/places/inner']);
  assert.deepEqual(shape(visibleRows(roots, all)), [
    'wiki/',
    '  people/',
    '    ada',
    '    Zed',
    '  places/',
    '    inner/',
    '      Deep',
    '  Places/',
    '    Vell',
    '  Page 2',
    '  page 10',
    '  People notes',
    'sources/',
  ]);
});

// Rule: the rows drawn are those of open folders only, so a closed folder costs one row
// however many pages it holds, and each row knows its folder, for the keys that walk the tree.
test('only open folders draw their rows', () => {
  const ids: string[] = [];
  for (let f = 0; f < 50; f++) for (let p = 0; p < 100; p++) ids.push(`sources/F${f}/P${p}.html`);
  ids.push('wiki/Top.html');
  const roots = buildTree(ids.map(page));
  assert.deepEqual(roots.map((r) => r.count), [1, 5000], 'a folder counts the pages in the folders inside it');
  const rows = visibleRows(roots, new Set(['wiki', 'sources']));
  assert.equal(rows.length, 1 + 1 + 1 + 50, 'two roots, one wiki page and fifty closed folders');
  const f3 = rows.find((r) => r.key === 'sources/F3')!;
  assert.deepEqual([f3.kind, f3.depth, f3.parent, f3.kind === 'folder' && f3.open, f3.kind === 'folder' && f3.count], ['folder', 1, 'sources', false, 100]);
  const opened = visibleRows(roots, new Set(['wiki', 'sources', 'sources/F3']));
  assert.equal(opened.length, rows.length + 100);
  const p0 = opened.find((r) => r.key === 'sources/F3/P0.html')!;
  assert.deepEqual([p0.kind, p0.depth, p0.parent], ['page', 2, 'sources/F3']);
  assert.equal(visibleRows(roots, new Set()).length, 2, 'closed roots draw only themselves');
});

const LISTED = ['wiki/People/Ada Vell.html', 'wiki/Harbour.html', 'sources/Harbour.html', 'sources/Notes/Tides.html'].map(page);

// Rule: a rename keeps the page in its folder and asks for the new title's path; a title the
// store would refuse, or one another page of the same tree holds (case aside), is refused
// here with its reason in plain words, and an unchanged title asks for nothing.
test('a rename asks for its path in the same folder, or says why not', () => {
  const rename = (id: string, value: string) => judge({ op: 'rename', id, value }, LISTED);
  assert.deepEqual(rename('wiki/People/Ada Vell.html', 'Ada Brook'), { kind: 'send', tree: 'wiki', path: 'People/Ada Brook.html' });
  assert.deepEqual(rename('wiki/People/Ada Vell.html', 'Ada Vell'), { kind: 'same' });
  assert.deepEqual(rename('wiki/People/Ada Vell.html', 'ada vell'), { kind: 'send', tree: 'wiki', path: 'People/ada vell.html' }, 'a change of case is its own page still');
  assert.deepEqual(rename('sources/Notes/Tides.html', 'harbour'), { kind: 'refused', code: 'taken', message: 'There is already a page called “Harbour” in sources. Pick another title.' });
  const refused = (value: string) => {
    const v = rename('wiki/Harbour.html', value);
    assert.equal(v.kind, 'refused', value);
    return v.kind === 'refused' ? [v.code, v.message] : [];
  };
  assert.deepEqual(refused(''), ['title', 'A page needs a title. Type one, or press Esc to cancel.']);
  assert.deepEqual(refused(' Harbour'), ['title', 'A title can\'t start or end with a space. Take the space out.']);
  assert.deepEqual(refused('Harbour [old]'), ['title', 'A title can\'t hold [ ] | # or ^, because a [[link]] ends there. Take that character out.']);
  assert.deepEqual(refused('Old/Harbour'), ['title', 'A title can\'t hold a slash. To put the page in another folder, choose Move.']);
  assert.deepEqual(refused('.Harbour'), ['unsafe', 'A title can\'t start with a dot or hold a backslash. Change the title.']);
  assert.deepEqual(refused('Har\\bour'), ['unsafe', 'A title can\'t start with a dot or hold a backslash. Change the title.']);
  assert.deepEqual(rename('wiki/Gone.html', 'Here'), {
    kind: 'refused', code: 'missing', message: '“Gone” is no longer there. It may have been moved or removed outside NEO. Choose Refresh to see the pages as they are now.',
  });
});

// Rule: a rename onto a title the other tree holds is refused, as the store refuses it,
// because it would move where that title's links go; a change of case alone, and a new
// page, may share a title with the other tree.
test('a rename onto a title of the other tree is refused in plain words', () => {
  const rename = (id: string, value: string) => judge({ op: 'rename', id, value }, LISTED);
  assert.deepEqual(rename('wiki/People/Ada Vell.html', 'tides'), {
    kind: 'refused', code: 'other-tree',
    message: 'There is already a page called “Tides” in sources/Notes. Renaming this page to that title would change where links to “Tides” go. Pick another title.',
  });
  const back = rename('sources/Notes/Tides.html', 'Ada Vell');
  assert.equal(back.kind === 'refused' && back.code, 'other-tree', 'both ways');
  assert.deepEqual(rename('wiki/Harbour.html', 'HARBOUR'), { kind: 'send', tree: 'wiki', path: 'HARBOUR.html' });
  assert.deepEqual(judge({ op: 'new', tree: 'sources', folder: '', value: 'Ada Vell' }, LISTED), { kind: 'send', tree: 'sources', path: 'Ada Vell.html' });
});

// Rule: a move keeps the page's title and tree and asks for the path in the folder typed
// (slashes and spaces at its ends set aside, empty for the top of the tree); a folder the
// store would refuse is refused here, and the folder the page is in asks for nothing.
test('a move asks for the path in the folder typed, inside the same tree', () => {
  const move = (id: string, value: string) => judge({ op: 'move', id, value }, LISTED);
  assert.deepEqual(move('wiki/Harbour.html', 'Places/Coast'), { kind: 'send', tree: 'wiki', path: 'Places/Coast/Harbour.html' });
  assert.deepEqual(move('wiki/People/Ada Vell.html', ' /Places/ '), { kind: 'send', tree: 'wiki', path: 'Places/Ada Vell.html' });
  assert.deepEqual(move('wiki/People/Ada Vell.html', ''), { kind: 'send', tree: 'wiki', path: 'Ada Vell.html' });
  assert.deepEqual(move('wiki/People/Ada Vell.html', 'People/'), { kind: 'same' });
  assert.deepEqual(move('sources/Notes/Tides.html', 'wiki'), { kind: 'send', tree: 'sources', path: 'wiki/Tides.html' }, 'a folder typed is inside the page\'s own tree');
  for (const bad of ['../Out', 'A//B', '.hidden', 'A\\B']) {
    assert.deepEqual(move('wiki/Harbour.html', bad), {
      kind: 'refused', code: 'unsafe', message: 'A folder name can\'t be empty, be . or .., start with a dot, or hold a backslash. Change the folder.',
    }, bad);
  }
  const twin = [...LISTED, page('wiki/Old/harbour.html')];
  assert.deepEqual(judge({ op: 'move', id: 'wiki/Harbour.html', value: 'Places' }, twin), {
    kind: 'refused', code: 'taken', message: 'There is already a page called “harbour” in wiki/Old. Pick another title.',
  });
});

// Rule: a new page goes in the folder chosen, under the title typed, on the same rules.
test('a new page asks for its path in the folder chosen, or says why not', () => {
  const make = (tree: Tree, folder: string, value: string) => judge({ op: 'new', tree, folder, value }, LISTED);
  assert.deepEqual(make('wiki', 'People', 'Bo Reed'), { kind: 'send', tree: 'wiki', path: 'People/Bo Reed.html' });
  assert.deepEqual(make('sources', '', 'Bo Reed'), { kind: 'send', tree: 'sources', path: 'Bo Reed.html' });
  assert.deepEqual(make('wiki', 'People', 'ada vell'), { kind: 'refused', code: 'taken', message: 'There is already a page called “Ada Vell” in wiki/People. Pick another title.' });
  assert.equal(make('wiki', '', '').kind, 'refused');
});

// Rule: when the store refuses what the window let through (the library changed since the
// list was read), the reason comes from the library as it is now, else the store's words.
test('a refusal from the store is explained from the list read again', () => {
  const ask = { op: 'rename', id: 'wiki/Harbour.html', value: 'Quay' } as const;
  assert.equal(explain(ask, LISTED.filter((p) => p.id !== 'wiki/Harbour.html'), new Error('x')).code, 'missing');
  assert.deepEqual(explain(ask, [...LISTED, page('wiki/Docks/Quay.html')], new Error('x')), {
    code: 'taken', message: 'There is already a page called “Quay” in wiki/Docks. Pick another title.',
  });
  assert.deepEqual(explain(ask, LISTED, new Error('plugin hoard: pages.rename failed: the disk is full')), {
    code: null, message: 'The page could not be renamed: the disk is full. Try again, or choose Refresh.',
  });
});

// Rule: a move can pick any folder of the page's own tree, the top of it first.
test('the folders a move can pick are those of one tree', () => {
  const roots = buildTree([...LISTED, page('wiki/People/Kin/Bo.html')]);
  assert.deepEqual(foldersIn(roots, 'wiki'), ['', 'People', 'People/Kin']);
  assert.deepEqual(foldersIn(roots, 'sources'), ['', 'Notes']);
});

// The row editor's table (the header of wiki/tree.ts), walked one cell at a time.
const run = (events: EditorEvent[], from: Editor = CLOSED) => {
  let editor = from;
  const effects: string[] = [];
  for (const e of events) {
    const next = step(editor, e, LISTED);
    editor = next.editor;
    effects.push(next.effect);
  }
  return { editor, effects };
};
const renameHarbour = { type: 'start', ask: { op: 'rename', id: 'wiki/Harbour.html', value: 'Harbour' } } as const;

// Rule: a submit sends one request, and every gesture while it is in flight sends none:
// a second submit, Esc, typing, or another row's Rename only bring the open field back.
test('while a request is in flight no gesture sends another', () => {
  const { editor, effects } = run([renameHarbour, { type: 'input', value: 'Quay' }, { type: 'submit' },
    { type: 'submit' }, { type: 'cancel' }, { type: 'input', value: 'Pier' }, { type: 'blur' },
    { type: 'start', ask: { op: 'move', id: 'wiki/People/Ada Vell.html', value: 'People' } }, renameHarbour]);
  assert.deepEqual(effects, ['focus-field', 'none', 'send', 'none', 'none', 'none', 'none', 'busy', 'focus-field']);
  assert.deepEqual(editor, { state: 'pending', ask: { op: 'rename', id: 'wiki/Harbour.html', value: 'Quay' }, initial: 'Harbour' });
});

// Rule: the store's answer settles the request: done closes the field, a refusal opens it
// again with the typed value kept and the reason shown; an answer with nothing in flight
// changes nothing.
test('the answer closes the field, or opens it again with the value kept', () => {
  const sent = run([renameHarbour, { type: 'input', value: 'Quay' }, { type: 'submit' }]).editor;
  assert.deepEqual(run([{ type: 'done' }], sent), { editor: CLOSED, effects: ['settled'] });
  assert.deepEqual(run([{ type: 'refused', message: 'Taken.' }], sent).editor, {
    state: 'open', ask: { op: 'rename', id: 'wiki/Harbour.html', value: 'Quay' }, initial: 'Harbour', error: 'Taken.',
  });
  assert.deepEqual(run([{ type: 'done' }, { type: 'refused', message: 'x' }]), { editor: CLOSED, effects: ['none', 'none'] });
  const open = run([renameHarbour]).editor;
  assert.deepEqual(run([{ type: 'done' }], open), { editor: open, effects: ['none'] });
});

// Rule: a field is judged on submit and on leaving it once changed, never while a fresh
// field is typed in; once it shows an error, each change judges it again; a submit that
// changes nothing, or Esc, closes it and sends nothing.
test('a field is judged on submit and on blur, and an unchanged one closes', () => {
  const typed = run([renameHarbour, { type: 'input', value: 'Har|' }]).editor;
  assert.equal(typed.state === 'open' && typed.error, null, 'no error while typing a fresh field');
  const blurred = run([{ type: 'blur' }], typed).editor;
  assert.match(blurred.state === 'open' ? blurred.error ?? '' : '', /can't hold \[ \] \| # or \^/);
  const fixed = run([{ type: 'input', value: 'Harbours' }], blurred).editor;
  assert.equal(fixed.state === 'open' && fixed.error, null, 'a field showing an error is judged again as it changes');
  assert.deepEqual(run([{ type: 'blur' }], run([renameHarbour]).editor).effects, ['none']);
  const fresh = run([{ type: 'start', ask: { op: 'new', tree: 'wiki', folder: '', value: '' } }, { type: 'blur' }]).editor;
  assert.equal(fresh.state === 'open' && fresh.error, null, 'leaving an untouched New page field shows no error');
  const refusedOnSubmit = run([{ type: 'input', value: 'harbour' }, { type: 'input', value: '' }, { type: 'submit' }], run([renameHarbour]).editor);
  assert.deepEqual([refusedOnSubmit.editor.state, refusedOnSubmit.effects.at(-1)], ['open', 'focus-field']);
  assert.deepEqual(run([renameHarbour, { type: 'submit' }]), { editor: CLOSED, effects: ['focus-field', 'focus-origin'] });
  assert.deepEqual(run([renameHarbour, { type: 'input', value: 'Quay' }, { type: 'cancel' }]), { editor: CLOSED, effects: ['focus-field', 'none', 'focus-origin'] });
  assert.deepEqual(run([{ type: 'submit' }, { type: 'cancel' }, { type: 'input', value: 'x' }]), { editor: CLOSED, effects: ['none', 'none', 'none'] });
});

// Rule: a new page is what wiki import makes of an empty file: one empty paragraph carrying
// a fresh six-digit block id, so a [[Page#^id]] citation can point at it from the start.
test('a new page is one empty paragraph with its own block id', () => {
  assert.equal(newPageHtml(() => 'abc123'), '<p data-block="abc123"><br></p>');
  const [a, b] = [newPageHtml(), newPageHtml()];
  assert.match(a, /^<p data-block="[0-9a-f]{6}"><br><\/p>$/);
  assert.notEqual(a, b, 'each new page has a block id of its own');
});
