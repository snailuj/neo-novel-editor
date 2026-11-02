// The wiki's main half: Import to Wiki asks for Markdown files, Import List for an import
// list naming them (import-list.ts), and both say what would come in and import on the
// writer's word; the window asks for the pages to follow links and for one page to show
// in the wiki pane. The questions are OS message boxes, never while the writer types: the
// writer chose the command.
//
// A list sends each page where its line says: to the page files of sources/ (the default)
// or wiki/ (page-import.ts), or, after a `book:` line, into a NEO book (Morning Pages,
// say), each filled by a store of its own; Open Imported Book… asks which book to open,
// since none is on a shelf. Import to Wiki still fills the Wiki book, which the readers
// that have not moved to page files yet (search, marks, Ripple, the pane) still read.
import { BrowserWindow, dialog } from 'electron';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateHoardWikiImportV1, validateHoardWikiPageV1, validateHoardWikiV1 } from '../../generated/validators.cjs';
import { key } from '../../librarian/links.ts';
import { checked } from '../checked.ts';
import type { GitLayer } from '../git/layer.ts';
import { oneName } from '../files.ts';
import type { MarkStore } from '../marks/store.ts';
import type { Tree } from '../pages/identity.ts';
import { ListError, readImportList, type ImportList } from './import-list.ts';
import { PageImport, type PageMarks } from './page-import.ts';
import type { Pick, SortedOf } from './picks.ts';
import { WikiStore } from './store.ts';
import { describeSort } from './summary.ts';

function parentWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function messageBox(options: Electron.MessageBoxOptions) {
  const parent = parentWindow();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

function openDialog(options: Electron.OpenDialogOptions) {
  const parent = parentWindow();
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// The picks the writer chose, a list's rows left out (with why), or null for a cancel.
async function choose(from: 'pages' | 'list', host: NeoMainHost): Promise<{ picks: DestPick[]; left: ImportList['left'] } | { failed: string } | null> {
  if (from === 'pages') {
    const pick = await openDialog({
      title: 'Import to Wiki', buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    return pick.canceled || pick.filePaths.length === 0 ? null : { picks: pick.filePaths.map((path) => ({ path, to: null, book: null })), left: [] };
  }
  const pick = await openDialog({
    title: 'Import List', buttonLabel: 'Import',
    properties: ['openFile'], filters: [{ name: 'Import list', extensions: ['txt', 'csv'] }],
  });
  const file = pick.filePaths[0];
  if (pick.canceled || !file) return null;
  try {
    const list = readImportList(file, readFileSync(file, 'utf8'));
    host.log('info', 'wiki.import-list', { file, entries: list.entries.length, left: list.left.length });
    return { picks: list.entries.map(({ path, name, folder, section, sha, to, book }) => ({ path, name, folder, section, sha, to, book })), left: list.left };
  } catch (err) {
    const why = err instanceof ListError ? `${file}, ${err.message}.` : `${file} does not read: ${String(err)}`;
    host.log('warn', 'wiki.import-list does not read', why);
    await messageBox({
      type: 'warning', message: 'The import list does not read, so nothing was imported.',
      detail: `${why}\n\nA list names one Markdown page a line, or is a keep/move .csv with path and verdict columns.`,
    });
    return { failed: why };
  }
}

// A pick and where it goes: a tree of page files, a NEO book by title, or (both null) the Wiki book.
type DestPick = Pick & { to: Tree | null; book: string | null };

/** One place an import fills, whatever it is: a tree of page files, or a NEO book. */
interface Target {
  /** In words: sources, the wiki, or a book's title. */
  where: string;
  sort(picks: Pick[]): SortedOf<object>;
  apply(sorted: SortedOf<object>, openBookId: string | null): Promise<Done>;
  /** The NEO book it fills, which NEO must not have open; null for a tree. */
  bookId(): string | null;
  /** The button that opens what it filled, or null when there is nothing to open. */
  button: string | null;
}

interface Done {
  bookId: string | null;
  imported: number;
  updated: number;
  marks: number;
  marksLeft: number;
  keptAsText: number;
  attachments: number;
  missing: string[];
}

function bookTarget(store: WikiStore): Target {
  const wiki = store.title === 'Wiki';
  return {
    where: wiki ? 'the wiki' : store.title,
    sort: (picks) => store.sort(picks),
    apply: async (sorted, openBookId) => {
      const a = await store.apply(sorted as ReturnType<WikiStore['sort']>, openBookId);
      return { bookId: a.bookId, imported: a.imported.length, updated: a.updated.length, marks: a.marks, marksLeft: 0, keptAsText: a.keptAsText, attachments: a.attachments, missing: a.missing };
    },
    bookId: () => store.wikiId(),
    button: wiki ? 'Open Wiki Book' : `Open ${store.title}`,
  };
}

function treeTarget(into: PageImport, wrote: () => Promise<unknown>): Target {
  return {
    where: into.tree === 'wiki' ? 'the wiki' : 'sources',
    sort: (picks) => into.sort(picks),
    apply: async (sorted) => {
      const a = await into.apply(sorted as ReturnType<PageImport['sort']>);
      await wrote();
      return { bookId: null, imported: a.imported.length, updated: a.updated.length, marks: a.marks, marksLeft: a.marksLeft, keptAsText: a.keptAsText, attachments: a.attachments, missing: a.missing };
    },
    bookId: () => null,
    button: null,
  };
}

// Where a list's picks go, in that order: sources, the wiki, then each book in the list's order.
function byDest(picks: DestPick[], targets: Targets): { target: Target; picks: Pick[] }[] {
  const groups = new Map<string, { rank: number; target: Target; picks: Pick[] }>();
  for (const { to, book, ...pick } of picks) {
    const k = to ? `tree:${to}` : book ? `book:${key(book)}` : 'wiki-book';
    let group = groups.get(k);
    if (!group) {
      const rank = to === 'sources' ? 0 : to === 'wiki' ? 1 : book ? 3 + groups.size : 2;
      groups.set(k, group = { rank, target: targets.for(to, book), picks: [] });
    }
    group.picks.push(pick);
  }
  return [...groups.values()].sort((a, b) => a.rank - b.rank);
}

const joined = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

async function runImport(host: NeoMainHost, targets: Targets, from: 'pages' | 'list', openBookId: string | null) {
  const chosen = await choose(from, host);
  if (chosen === null) return { outcome: 'cancelled' };
  if ('failed' in chosen) return { outcome: 'failed', message: chosen.failed };
  const groups = byDest(chosen.picks, targets).map((g) => {
    const sorted = g.target.sort(g.picks);
    return { target: g.target, sorted, summary: describeSort(sorted, g.target.where) };
  });
  const count = groups.reduce((n, g) => n + g.summary.count, 0);
  const many = groups.length > 1;
  const left = chosen.left.length
    ? `\n\nLeft out by the list: ${chosen.left.slice(0, 12).map((l) => `${l.path} (${l.why})`).join(', ')}${chosen.left.length > 12 ? ` and ${chosen.left.length - 12} more` : ''}.`
    : '';
  const detail = groups.map((g) => (many ? `Into ${g.target.where}:\n\n${g.summary.detail}` : g.summary.detail)).join('\n\n') + left;
  const message = many
    ? (count ? `Import ${count} page${count === 1 ? '' : 's'} into ${joined(groups.filter((g) => g.summary.count).map((g) => g.target.where))}?` : 'Every page picked is already where it goes, or cannot come in.')
    : groups[0]!.summary.message;
  if (count === 0) {
    await messageBox({ type: 'info', message, detail });
    return { outcome: 'nothing' };
  }
  const open = groups.find((g) => g.summary.count && openBookId !== null && g.target.bookId() === openBookId);
  if (open) {
    const what = open.target.where;
    await messageBox({ type: 'info', message: `${what[0]!.toUpperCase()}${what.slice(1)} is open, so nothing was imported.`, detail: 'Go back to the shelf and import again. NEO writes the open book\'s page list itself, and would write over the new pages.' });
    return { outcome: 'wiki-open' };
  }
  const asked = await messageBox({
    type: 'question', message, detail,
    buttons: [`Import ${count} Page${count === 1 ? '' : 's'}`, 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (asked.response !== 0) return { outcome: 'cancelled' };
  // Book by book; a book that stops keeps what was written, and the books after it wait.
  const done: { target: Target; applied: Done }[] = [];
  for (const g of groups.filter((x) => x.summary.count)) {
    try {
      done.push({ target: g.target, applied: await g.target.apply(g.sorted, openBookId) });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      host.log('error', 'wiki.import failed', why);
      const landed = done.length ? ` ${joined(done.map((d) => d.target.where))} took ${plural(done.length, 'its', 'their')} pages before it stopped.` : '';
      await messageBox({ type: 'warning', message: 'The import stopped.', detail: `${why}${landed}\n\nWhat was written stays, and importing the same files again finishes it.` });
      return { outcome: 'failed', message: why };
    }
  }
  const sum = (f: (a: Done) => number) => done.reduce((n, d) => n + f(d.applied), 0);
  const updated = sum((a) => a.updated);
  const marks = sum((a) => a.marks);
  const marksLeft = sum((a) => a.marksLeft);
  const keptAsText = sum((a) => a.keptAsText);
  const attachments = sum((a) => a.attachments);
  const missing = done.flatMap((d) => d.applied.missing);
  const n = sum((a) => a.imported + a.updated);
  const into = joined(done.map((d) => d.target.where));
  const copiedInto = joined(done.filter((d) => d.applied.attachments).map((d) => d.target.where));
  const said = [
    updated ? `${updated} ${plural(updated, 'page was', 'pages were')} updated from a newer source.` : '',
    marks ? `${marks} ${plural(marks, 'mark', 'marks')} came with them.` : '',
    marksLeft ? `${marksLeft} CriticMarkup ${plural(marksLeft, 'mark was', 'marks were')} left out, because page files cannot hold marks yet.` : '',
    keptAsText ? `${keptAsText} CriticMarkup ${plural(keptAsText, 'mark stays', 'marks stay')} in the text as written, because ${plural(keptAsText, 'it', 'they')} cannot be a mark here.` : '',
    attachments ? `${attachments} ${plural(attachments, 'image or PDF was', 'images or PDFs were')} copied into ${copiedInto}.` : '',
    missing.length ? `Not found, so not copied: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}.` : '',
    done.some((d) => d.target.button && d.target.button !== 'Open Wiki Book') ? 'A book an import list fills is on no shelf: Plugins > Open Imported Book… opens it.' : '',
  ].filter(Boolean);
  const openable = done.filter((d) => d.target.button);
  const answer = await messageBox({
    type: 'info', message: `${n} page${n === 1 ? ' is' : 's are'} in ${into}.`, detail: said.join(' '),
    buttons: [...openable.map((d) => d.target.button!), 'Close'],
    defaultId: 0, cancelId: openable.length, noLink: true,
  });
  const chosenBook = openable[answer.response];
  const wikiBook = chosenBook?.target.button === 'Open Wiki Book';
  return {
    outcome: 'imported',
    bookId: done[0]!.applied.bookId,
    open: wikiBook,
    openBookId: chosenBook && !wikiBook ? chosenBook.applied.bookId : null,
  };
}

// The Wiki book's store, the two trees, and a store for each other book an import list
// names, made when first asked for.
class Targets {
  readonly wiki: WikiStore;
  readonly #books = new Map<string, Target>();
  readonly #trees: Record<Tree, Target>;
  readonly #make: (book?: string) => WikiStore;

  constructor(make: (book?: string) => WikiStore, tree: (tree: Tree) => PageImport, wrote: () => Promise<unknown>) {
    this.#make = make;
    this.wiki = make();
    this.#trees = { sources: treeTarget(tree('sources'), wrote), wiki: treeTarget(tree('wiki'), wrote) };
  }

  for(to: Tree | null, book: string | null): Target {
    if (to) return this.#trees[to];
    if (book === null) return bookTarget(this.wiki);
    let target = this.#books.get(key(book));
    if (!target) this.#books.set(key(book), target = bookTarget(this.#make(book)));
    return target;
  }
}

// The books import lists have made beside the wiki, by their files in .neo/books.
function importedBooks(library: string, log: NeoMainHost['log']): { bookId: string; title: string }[] {
  const dir = path.join(library, '.neo', 'books');
  if (!existsSync(dir)) return [];
  const books: { bookId: string; title: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const named = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown;
      if (!validateHoardWikiV1(named)) continue;
      const bookFile = path.join(library, oneName(named.bookId, 'bookId'), 'book.json');
      if (!existsSync(bookFile)) continue;
      const book = JSON.parse(readFileSync(bookFile, 'utf8')) as { title?: unknown };
      books.push({ bookId: named.bookId, title: typeof book.title === 'string' && book.title ? book.title : file.slice(0, -5) });
    } catch (err) {
      log('warn', `wiki: ${path.join(dir, file)} does not read`, String(err));
    }
  }
  return books;
}

// Which imported book to open: the only one, or the writer's pick of them; null for none.
async function pickImportedBook(host: NeoMainHost): Promise<{ bookId: string | null }> {
  const books = importedBooks(host.paths.library(), host.log.bind(host));
  if (books.length === 0) {
    await messageBox({ type: 'info', message: 'No import list has filled a book beside the wiki yet.', detail: 'A `book: Title` line in an import list sends the pages after it into a book of that title.' });
    return { bookId: null };
  }
  if (books.length === 1) return { bookId: books[0]!.bookId };
  const shown = books.slice(0, 8);
  const answer = await messageBox({
    type: 'question', message: 'Open which imported book?',
    detail: books.length > shown.length ? `The first ${shown.length} of ${books.length} are shown.` : '',
    buttons: [...shown.map((b) => b.title), 'Cancel'], cancelId: shown.length, noLink: true,
  });
  return { bookId: shown[answer.response]?.bookId ?? null };
}

/**
 * `pageMarks` holds the marks of imported pages; `pagesWrote` is told when an import has
 * written page files, so the page store reads its trees again (pages/store.ts).
 */
export function startWiki(host: NeoMainHost, layer: GitLayer, marks: MarkStore, o: { pageMarks?: PageMarks; pagesWrote?: () => Promise<unknown> } = {}): WikiStore {
  const { pageMarks, pagesWrote = () => Promise.resolve() } = o;
  const targets = new Targets((book) => new WikiStore({
    library: () => host.paths.library(),
    marks,
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    commit: (part) => layer.commitNow(part === 'author' ? 'import-author' : 'import'),
    log: host.log.bind(host),
    ...(book === undefined ? {} : { book }),
  }), (tree) => new PageImport({
    library: () => host.paths.library(),
    tree,
    ...(pageMarks ? { marks: pageMarks } : {}),
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    commit: (part) => layer.commitNow(part === 'author' ? 'import-author' : 'import'),
    log: host.log.bind(host),
  }), pagesWrote);
  const wiki = targets.wiki;
  host.handle('wiki.pages', () => wiki.pages());
  host.handle('wiki.page', (payload) => wiki.page(checked('wiki.page', validateHoardWikiPageV1, payload).chId));
  host.handle('wiki.import', (payload) => {
    const { openBookId, from = 'pages' } = checked('wiki.import', validateHoardWikiImportV1, payload);
    return runImport(host, targets, from, openBookId);
  });
  host.handle('wiki.imported-book', () => pickImportedBook(host));
  return wiki;
}
