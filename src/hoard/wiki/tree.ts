// The Pages tree on the Pages tab of the left pane, as data. Pure: the view
// (wiki/pane-tree.ts) draws what this works out. The pages come from one pages.list; each
// tree (wiki/, sources/) shows its folders first, by name, then its pages, by title. Only the
// rows of open folders are worked out, so a library of thousands of pages in closed folders
// draws a few rows.
//
// ---- State machine (ui-state-design) ------------------------------------------------------
// Two regions, two tables. Fixed by the plan's rulings: a stored page's text is edited in
// the page column (wiki/pane-edit.ts), not from the tree; a move stays inside the page's tree
// (Move-Within-Tree); the list is read when the tab first shows after a book opens, after
// each change and on Refresh (Tree-Refresh); there is no folder rename, folder delete or page
// delete (Folder-Actions). Focus rule for every cell: the tree moves the focus only when it
// is already in the tab, or the writer asked for the tree (Show in Pages, Rename from the
// column); otherwise the writer stays where they are.
//
// A. The list. States, and what tells them apart:
//   Unread      the tab not yet shown since the book opened; nothing read.
//   Reading     "Reading pages…" in the status line; Refresh disabled; earlier rows stay.
//   Listed      the rows; the page shown carries aria-current and a mark.
//   Filtered    the filter holds words: only titles holding them, the folders above them
//               open; none matching says so and how to see every page again.
//   Empty       "No pages yet…" saying where pages live and that New page makes one.
//   ReadFailed  an alert naming what failed and "Choose Refresh to try again".
//   event          Unread             Reading                 Listed / Filtered / Empty / ReadFailed
//   tab shows      read list          no-op                   no-op (read again only after a book opens)
//   Refresh        hidden             no-op: disabled+guarded  read list -> Reading
//   reply ok       -                  Listed or Empty         (a stale reply is dropped)
//   reply failed   -                  ReadFailed              (a stale reply is dropped)
//   filter typed   -                  narrows the rows held   Filtered; cleared -> Listed as it was
//   page row       hidden             earlier rows still open  open in the column; focus stays on the row
//   folder row     hidden             toggles open/closed      toggles open/closed; focus stays
//   Repeats: Refresh twice reads once; a page row twice shows the page once (the trail takes
//   no second stop); a folder row toggles, in the filtered tree too, which keeps its own open
//   folders so clearing the filter gives back the writer's. Only a newer read's reply is
//   drawn. Mutates nothing, so there is no undo.
//
// B. The row editor (Rename, Move, New page). States:
//   closed   no field.
//   open     a labelled field with its action button and Cancel; error null.
//   invalid  as open, with aria-invalid and the reason in words under it (role=alert).
//   pending  the field read-only, aria-busy; the action button disabled and saying
//            "Renaming…", "Moving…" or "Making…".
//   event              closed           open / invalid                                pending
//   start (F2, menus,  open the field;  same field: focus it; another row: focus the   focus the field ("busy"),
//     New page)        focus it         open field and say finish or cancel ("busy")  no request
//   input              -                keep the value; invalid judges it again       no-op (read-only)
//   blur               -                judge it if changed -> invalid / open         no-op
//   submit (Enter,     -                refused -> invalid, focus field; unchanged ->  no-op: guarded and
//     action button)                    closed, focus origin; else pending, send once  disabled, so one request
//   cancel (Esc)       -                closed, focus origin, nothing sent             no-op: it cannot be called back
//                                                                                     (NEO's Esc takes the writer to the page)
//   reply done         -                no-op                                          closed; list read again; focus the
//                                                                                     page's row if focus was in the tab
//   reply refused      -                no-op                                          invalid with the reason, value
//                                                                                     kept; focus the field if in the tab
//   page gone (the     -                closed; the alert says it is gone and nothing  as open / invalid
//     list read again                   changed; focus its folder row if in the tab
//     lacks it)
//   folder gone (the   -                a new page's field moves to the nearest       as it is: the store makes the
//     list read again                   folder above still there, title kept; the     folder; a refusal then moves it
//     lacks a new                       status says where; the focus stays
//     page's folder)
//   A slow reply stays pending: the writer can keep writing, read pages and leave the tab;
//   nothing times out, because the store finishes a rename it started even after a restart.
//   Origin is the row (or the New page button) that opened the field. Inverses: a rename or
//   a move is undone by another (links follow both ways); a new page has no undo in the
//   tree (Folder-Actions leaves out page delete): its file is removed from the folder.
import { key } from '../../librarian/links.ts';
import { checkPath, checkTitle, PageRefused, titleOf, TREES, type Tree } from '../pages/identity.ts';
import { titleIndex } from '../pages/titles.ts';
import { convertPage } from './convert.ts';

/** What the tree needs of a pages.list entry. */
export interface Listed {
  id: string;
  tree: Tree;
  path: string;
  title: string;
}

export interface Folder {
  /** The tree and the folder's path in it, as an id names a page: `wiki` or `wiki/People`. */
  key: string;
  tree: Tree;
  /** The folder's path inside its tree; '' for the tree's own folder. */
  path: string;
  name: string;
  folders: Folder[];
  pages: Listed[];
  /** Pages in this folder and every folder inside it. */
  count: number;
}

interface RowBase {
  key: string;
  tree: Tree;
  path: string;
  name: string;
  depth: number;
  /** The folder row this row sits in; null for a tree's own folder. */
  parent: string | null;
}
export type Row = (RowBase & { kind: 'folder'; open: boolean; count: number }) | (RowBase & { kind: 'page' });

// numbers by value, then a total order so the same list always draws the same way
const collator = new Intl.Collator(undefined, { numeric: true });
const byName = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** The folder a page path sits in, '' at the top of its tree. */
export const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export function buildTree(entries: readonly Listed[]): Folder[] {
  const folders = new Map<string, Folder>();
  const folder = (tree: Tree, path: string): Folder => {
    const key = path ? `${tree}/${path}` : tree;
    let f = folders.get(key);
    if (!f) {
      f = { key, tree, path, name: path ? path.slice(path.lastIndexOf('/') + 1) : tree, folders: [], pages: [], count: 0 };
      folders.set(key, f);
      if (path) folder(tree, folderOf(path)).folders.push(f);
    }
    return f;
  };
  const roots = TREES.map((tree) => folder(tree, ''));
  for (const entry of entries) {
    folder(entry.tree, folderOf(entry.path)).pages.push(entry);
    for (let at = folderOf(entry.path); ; at = folderOf(at)) {
      folder(entry.tree, at).count++;
      if (!at) break;
    }
  }
  for (const f of folders.values()) {
    f.folders.sort((a, b) => byName(a.name, b.name));
    f.pages.sort((a, b) => byName(a.title, b.title));
  }
  return roots;
}

/** The rows drawn, in order: each open folder's folders and pages under it. */
export function visibleRows(roots: readonly Folder[], open: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (f: Folder, depth: number, parent: string | null) => {
    const isOpen = open.has(f.key);
    rows.push({ kind: 'folder', key: f.key, tree: f.tree, path: f.path, name: f.name, depth, parent, open: isOpen, count: f.count });
    if (!isOpen) return;
    for (const sub of f.folders) walk(sub, depth + 1, f.key);
    for (const p of f.pages) rows.push({ kind: 'page', key: p.id, tree: p.tree, path: p.path, name: p.title, depth: depth + 1, parent: f.key });
  };
  for (const root of roots) walk(root, 0, null);
  return rows;
}

// a title as the filter compares it: case and accents aside
const plain = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();

/** The pages whose title holds the words typed; all of them for no words. Built into a tree, only their folders show. */
export function filterPages<T extends Listed>(entries: readonly T[], query: string): T[] {
  const words = plain(query);
  return words ? entries.filter((e) => plain(e.title).includes(words)) : [...entries];
}

/** Every folder's key, so a filtered tree draws each match with the folders above it open. */
export function allFolders(roots: readonly Folder[]): Set<string> {
  const keys = new Set<string>();
  const walk = (f: Folder) => { keys.add(f.key); f.folders.forEach(walk); };
  roots.forEach(walk);
  return keys;
}

const ROOT_NAMES: Record<Tree, string> = { wiki: 'Wiki', sources: 'Sources' };
/** What a row shows: a tree's own folder by its capitalised name, anything else as it is. */
export const rowName = (row: Row) => (row.parent === null ? ROOT_NAMES[row.tree] : row.name);
/** A row's accessible name: a folder's says how many pages it holds. */
export const rowLabel = (row: Row) => (row.kind === 'folder' ? `${rowName(row)}, ${row.count} page${row.count === 1 ? '' : 's'}` : row.name);

/** Every folder of one tree, as paths inside it, the top of the tree ('') first. */
export function foldersIn(roots: readonly Folder[], tree: Tree): string[] {
  const out: string[] = [];
  const walk = (f: Folder) => {
    out.push(f.path);
    for (const sub of f.folders) walk(sub);
  };
  const root = roots.find((r) => r.tree === tree);
  if (root) walk(root);
  return out;
}

// a block id as the wiki import makes one: six hex digits
const blockId = () => [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A new page's HTML: wiki import's page for an empty file, one empty paragraph with a block id. */
export const newPageHtml = (newId: () => string = blockId) => convertPage('', newId).html;

// ---- asking the store --------------------------------------------------------------------
// The store's refusal codes do not cross the window's invoke, so what it would refuse is
// worked out here first, from the list, on the store's own rules (pages/identity.ts).

export type Refusal = PageRefused['code'];

export type Ask =
  | { op: 'rename'; id: string; value: string }
  | { op: 'move'; id: string; value: string }
  | { op: 'new'; tree: Tree; folder: string; value: string };

export type Verdict =
  | { kind: 'send'; tree: Tree; path: string }
  | { kind: 'same' }
  | { kind: 'refused'; code: Refusal; message: string };

const DONE: Record<Ask['op'], string> = { rename: 'renamed', move: 'moved', new: 'made' };
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
/** A folder as the writer reads it: `wiki` or `wiki/People`. */
export const place = (tree: Tree, folder: string) => (folder ? `${tree}/${folder}` : tree);

const refused = (code: Refusal, message: string): Verdict => ({ kind: 'refused', code, message });

// The title rule is the store's (checkTitle); the words say which part of it was broken.
function titleRefusal(value: string): Verdict | null {
  if (value.includes('/')) return refused('title', 'A title can\'t hold a slash. To put the page in another folder, choose Move.');
  try {
    checkTitle(`${value}.html`);
    return null;
  } catch (err) {
    if (!(err instanceof PageRefused)) throw err;
  }
  if (value.trim() === '') return refused('title', 'A page needs a title. Type one, or press Esc to cancel.');
  if (value !== value.trim()) return refused('title', 'A title can\'t start or end with a space. Take the space out.');
  if (/[[\]|#^]/.test(value)) return refused('title', 'A title can\'t hold [ ] | # or ^, because a [[link]] ends there. Take that character out.');
  if (value.includes('`')) return refused('title', 'A title can\'t hold a backtick (`), because a [[link]] is not read after one. Take it out.');
  return refused('title', 'A title can\'t hold a tab, a line break or another hidden character. Take it out.');
}

const safe = (path: string) => {
  try {
    checkPath(path);
    return true;
  } catch (err) {
    if (err instanceof PageRefused) return false;
    throw err;
  }
};

/** What a rename, a move or a new page would ask the store for, judged against the list. */
export function judge(ask: Ask, entries: readonly Listed[]): Verdict {
  const index = titleIndex(entries);
  const taken = (tree: Tree, title: string, except?: string): Verdict | null => {
    const clash = index.taken(tree, title, except);
    return clash ? refused('taken', `There is already a page called “${clash.title}” in ${place(clash.tree, folderOf(clash.path))}. Pick another title.`) : null;
  };
  // the store's rule: a new title the other tree holds would re-point that page's links
  const otherTree = (entry: Listed, title: string): Verdict | null => {
    if (key(title) === key(entry.title)) return null;
    const held = index.taken(entry.tree === 'wiki' ? 'sources' : 'wiki', title);
    return held ? refused('other-tree', `There is already a page called “${held.title}” in ${place(held.tree, folderOf(held.path))}. Renaming this page to that title would change where links to “${held.title}” go. Pick another title.`) : null;
  };
  if (ask.op === 'new') {
    const path = join(ask.folder, `${ask.value}.html`);
    return titleRefusal(ask.value)
      ?? (safe(path) ? null : refused('unsafe', 'A title can\'t start with a dot or hold a backslash. Change the title.'))
      ?? taken(ask.tree, ask.value)
      ?? { kind: 'send', tree: ask.tree, path };
  }
  const entry = entries.find((e) => e.id === ask.id);
  if (!entry) {
    const gone = titleOf(ask.id);
    return refused('missing', `“${gone}” is no longer there, so nothing was changed. It may have been moved or removed outside NEO. Look for it in the list, which now shows the pages as they are.`);
  }
  if (ask.op === 'rename') {
    const path = join(folderOf(entry.path), `${ask.value}.html`);
    if (path === entry.path) return { kind: 'same' };
    return titleRefusal(ask.value)
      ?? (safe(path) ? null : refused('unsafe', 'A title can\'t start with a dot or hold a backslash. Change the title.'))
      ?? taken(entry.tree, ask.value, entry.id)
      ?? otherTree(entry, ask.value)
      ?? { kind: 'send', tree: entry.tree, path };
  }
  const folder = ask.value.trim().replace(/^\/+|\/+$/g, '');
  const path = join(folder, entry.path.slice(entry.path.lastIndexOf('/') + 1));
  if (path === entry.path) return { kind: 'same' };
  // the store checks the title on a move too, so a title no link could name stops it
  if (titleRefusal(entry.title)) return refused('title', `“${entry.title}” has a title no [[link]] can name, so it can't be moved. Rename it first, then move it.`);
  return (safe(path) ? null : refused('unsafe', 'A folder name can\'t be empty, be . or .., start with a dot, or hold a backslash. Change the folder.'))
    ?? taken(entry.tree, entry.title, entry.id)
    ?? { kind: 'send', tree: entry.tree, path };
}

/**
 * Why the store refused what judge let through, from the list read again after it did:
 * the library changed in between (another device, a file manager), or the store's own words.
 */
export function explain(ask: Ask, fresh: readonly Listed[], err: unknown): { code: Refusal | null; message: string } {
  const v = judge(ask, fresh);
  if (v.kind === 'refused') return { code: v.code, message: v.message };
  const why = (err instanceof Error ? err.message : String(err)).replace(/^plugin \S+: \S+ failed: /, '');
  // the store's words for a file on disk that the list shows as no page of that title
  const onDisk = /^(wiki|sources)\/(.+) is already a file on disk$/.exec(why);
  if (onDisk) {
    const file = onDisk[2]!;
    return { code: 'taken', message: `A file called “${file.slice(file.lastIndexOf('/') + 1)}” is already in ${place(onDisk[1] as Tree, folderOf(file))}. Pick another title.` };
  }
  return { code: null, message: `The page could not be ${DONE[ask.op]}: ${why}. Try again, or choose Refresh.` };
}

// ---- the row editor (table B above) -------------------------------------------------------
export type Editor =
  | { state: 'closed' }
  | { state: 'open'; ask: Ask; initial: string; error: string | null }
  | { state: 'pending'; ask: Ask; initial: string };

export type EditorEvent =
  | { type: 'start'; ask: Ask }
  | { type: 'input'; value: string }
  | { type: 'blur' }
  | { type: 'submit' }
  | { type: 'cancel' }
  | { type: 'done' }
  | { type: 'refused'; message: string }
  | { type: 'vanished' }
  | { type: 'listed' };

/**
 * focus-field and busy put the focus in the open field; focus-origin on what opened it;
 * focus-parent on the folder row that held a page gone from the list; folder-gone draws a
 * new page's field under the folder it moved to and says so.
 */
export type Effect = 'none' | 'focus-field' | 'busy' | 'focus-origin' | 'focus-parent' | 'send' | 'settled' | 'folder-gone';

export const CLOSED: Editor = Object.freeze({ state: 'closed' });

const target = (ask: Ask) => (ask.op === 'new' ? `${ask.tree}/${ask.folder}` : ask.id);
// a folder is there while a page is in it or below it, so the nearest one still there
const folderLeft = (tree: Tree, folder: string, entries: readonly Listed[]) => {
  for (let f = folder; f; f = folderOf(f)) {
    if (entries.some((e) => e.tree === tree && e.path.startsWith(`${f}/`))) return f;
  }
  return '';
};
const errorOf = (ask: Ask, entries: readonly Listed[]) => {
  const v = judge(ask, entries);
  return v.kind === 'refused' ? v.message : null;
};

export function step(editor: Editor, e: EditorEvent, entries: readonly Listed[]): { editor: Editor; effect: Effect; verdict?: Verdict } {
  const stay = { editor, effect: 'none' as Effect };
  if (editor.state === 'closed') {
    return e.type === 'start' ? { editor: { state: 'open', ask: e.ask, initial: e.ask.value, error: null }, effect: 'focus-field' } : stay;
  }
  if (e.type === 'vanished') return { editor: CLOSED, effect: 'focus-parent' };
  if (e.type === 'listed') {
    if (editor.state !== 'open' || editor.ask.op !== 'new') return stay;
    const folder = folderLeft(editor.ask.tree, editor.ask.folder, entries);
    if (folder === editor.ask.folder) return stay;
    const ask = { ...editor.ask, folder };
    return { editor: { ...editor, ask, error: editor.error === null ? null : errorOf(ask, entries) }, effect: 'folder-gone' };
  }
  if (e.type === 'start') {
    const same = e.ask.op === editor.ask.op && target(e.ask) === target(editor.ask);
    return { editor, effect: same ? 'focus-field' : 'busy' };
  }
  if (editor.state === 'pending') {
    if (e.type === 'done') return { editor: CLOSED, effect: 'settled' };
    if (e.type === 'refused') return { editor: { state: 'open', ask: editor.ask, initial: editor.initial, error: e.message }, effect: 'focus-field' };
    return stay;
  }
  switch (e.type) {
    case 'input': {
      const ask = { ...editor.ask, value: e.value };
      return { editor: { ...editor, ask, error: editor.error === null ? null : errorOf(ask, entries) }, effect: 'none' };
    }
    case 'blur':
      return editor.ask.value === editor.initial ? stay : { editor: { ...editor, error: errorOf(editor.ask, entries) }, effect: 'none' };
    case 'submit': {
      const verdict = judge(editor.ask, entries);
      if (verdict.kind === 'refused') return { editor: { ...editor, error: verdict.message }, effect: 'focus-field', verdict };
      if (verdict.kind === 'same') return { editor: CLOSED, effect: 'focus-origin', verdict };
      return { editor: { state: 'pending', ask: editor.ask, initial: editor.initial }, effect: 'send', verdict };
    }
    case 'cancel':
      return { editor: CLOSED, effect: 'focus-origin' };
    default:
      return stay;
  }
}

// ---- reading the list ---------------------------------------------------------------------
/**
 * Reads of the list: an ask while a read is out shares it (Refresh pressed twice reads once),
 * but fresh(), asked for after a change, waits for any read already out and reads anew, so
 * an answer from before the change is never taken for one after it.
 */
export function sharedReads<T>(read: () => Promise<T>) {
  let out: Promise<T> | null = null;
  const shared = (): Promise<T> => (out ??= read().finally(() => { out = null; }));
  return {
    shared,
    async fresh(): Promise<T> {
      if (out) await out.catch(() => {});
      return shared();
    },
  };
}
