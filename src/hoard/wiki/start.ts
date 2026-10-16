// The wiki's main half: Import to Wiki asks for Markdown files, Import List to Wiki for
// an import list naming them (import-list.ts), and both say what would come in and
// import on the writer's word; the window asks for the pages to follow links and for one
// page to show in the wiki pane. The questions are OS message boxes, never while the
// writer types: the writer chose the command. A list's `book:` lines send pages into
// other books (Morning Pages, say), each filled by a store of its own; Open Imported
// Book… asks which of them to open, since none is on a shelf.
import { BrowserWindow, dialog } from 'electron';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateHoardWikiImportV1, validateHoardWikiPageV1, validateHoardWikiV1 } from '../../generated/validators.cjs';
import { key } from '../../librarian/links.ts';
import { checked } from '../checked.ts';
import type { GitLayer } from '../git/layer.ts';
import { oneName } from '../files.ts';
import type { MarkStore } from '../marks/store.ts';
import { ListError, readImportList, type ImportList } from './import-list.ts';
import { WikiStore, type Applied, type Pick } from './store.ts';
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
async function choose(from: 'pages' | 'list', host: NeoMainHost): Promise<{ picks: (Pick & { book?: string | null })[]; left: ImportList['left'] } | { failed: string } | null> {
  if (from === 'pages') {
    const pick = await openDialog({
      title: 'Import to Wiki', buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    return pick.canceled || pick.filePaths.length === 0 ? null : { picks: pick.filePaths.map((path) => ({ path })), left: [] };
  }
  const pick = await openDialog({
    title: 'Import List to Wiki', buttonLabel: 'Import',
    properties: ['openFile'], filters: [{ name: 'Import list', extensions: ['txt', 'csv'] }],
  });
  const file = pick.filePaths[0];
  if (pick.canceled || !file) return null;
  try {
    const list = readImportList(file, readFileSync(file, 'utf8'));
    host.log('info', 'wiki.import-list', { file, entries: list.entries.length, left: list.left.length });
    return { picks: list.entries.map(({ path, name, section, sha, book }) => ({ path, name, section, sha, book })), left: list.left };
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

// The books a list's picks go to, in the list's order: the wiki first when it has any.
type BookPick = Pick & { book?: string | null };

function byBook(picks: BookPick[]): { book: string | null; picks: BookPick[] }[] {
  const groups = new Map<string, { book: string | null; picks: BookPick[] }>();
  for (const pick of picks) {
    const k = pick.book ? key(pick.book) : '';
    let group = groups.get(k);
    if (!group) groups.set(k, group = { book: pick.book ?? null, picks: [] });
    group.picks.push(pick);
  }
  return [...groups.values()].sort((a, b) => Number(a.book !== null) - Number(b.book !== null));
}

const named = (store: WikiStore) => (store.title === 'Wiki' ? 'the wiki' : store.title);
const joined = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

async function runImport(host: NeoMainHost, stores: Stores, from: 'pages' | 'list', openBookId: string | null) {
  const chosen = await choose(from, host);
  if (chosen === null) return { outcome: 'cancelled' };
  if ('failed' in chosen) return { outcome: 'failed', message: chosen.failed };
  const groups = byBook(chosen.picks).map((g) => {
    const store = stores.for(g.book);
    const sorted = store.sort(g.picks.map(({ book: _book, ...pick }) => pick));
    return { store, sorted, summary: describeSort(sorted, named(store)) };
  });
  const count = groups.reduce((n, g) => n + g.summary.count, 0);
  const many = groups.length > 1;
  const left = chosen.left.length
    ? `\n\nLeft out by the list: ${chosen.left.slice(0, 12).map((l) => `${l.path} (${l.why})`).join(', ')}${chosen.left.length > 12 ? ` and ${chosen.left.length - 12} more` : ''}.`
    : '';
  const detail = groups.map((g) => (many ? `Into ${named(g.store)}:\n\n${g.summary.detail}` : g.summary.detail)).join('\n\n') + left;
  const message = many
    ? (count ? `Import ${count} page${count === 1 ? '' : 's'} into ${joined(groups.filter((g) => g.summary.count).map((g) => named(g.store)))}?` : 'Every page picked is already in its book, or cannot come in.')
    : groups[0]!.summary.message;
  if (count === 0) {
    await messageBox({ type: 'info', message, detail });
    return { outcome: 'nothing' };
  }
  const open = groups.find((g) => g.summary.count && openBookId !== null && g.store.wikiId() === openBookId);
  if (open) {
    const what = named(open.store);
    await messageBox({ type: 'info', message: `${what[0]!.toUpperCase()}${what.slice(1)} is open, so nothing was imported.`, detail: 'Go back to the shelf and import again. NEO writes the open book\'s page list itself, and would write over the new pages.' });
    return { outcome: 'wiki-open' };
  }
  const asked = await messageBox({
    type: 'question', message, detail,
    buttons: [`Import ${count} Page${count === 1 ? '' : 's'}`, 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (asked.response !== 0) return { outcome: 'cancelled' };
  // Book by book; a book that stops keeps what was written, and the books after it wait.
  const done: { store: WikiStore; applied: Applied }[] = [];
  for (const g of groups.filter((x) => x.summary.count)) {
    try {
      done.push({ store: g.store, applied: await g.store.apply(g.sorted, openBookId) });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      host.log('error', 'wiki.import failed', why);
      const landed = done.length ? ` ${joined(done.map((d) => named(d.store)))} took ${plural(done.length, 'its', 'their')} pages before it stopped.` : '';
      await messageBox({ type: 'warning', message: 'The import stopped.', detail: `${why}${landed}\n\nWhat was written stays, and importing the same files again finishes it.` });
      return { outcome: 'failed', message: why };
    }
  }
  const sum = (f: (a: Applied) => number) => done.reduce((n, d) => n + f(d.applied), 0);
  const updated = sum((a) => a.updated.length);
  const marks = sum((a) => a.marks);
  const keptAsText = sum((a) => a.keptAsText);
  const attachments = sum((a) => a.attachments);
  const missing = done.flatMap((d) => d.applied.missing);
  const n = sum((a) => a.imported.length + a.updated.length);
  const into = joined(done.map((d) => named(d.store)));
  const said = [
    updated ? `${updated} ${plural(updated, 'page was', 'pages were')} updated from a newer source.` : '',
    marks ? `${marks} ${plural(marks, 'mark', 'marks')} came with them.` : '',
    keptAsText ? `${keptAsText} CriticMarkup ${plural(keptAsText, 'mark stays', 'marks stay')} in the text as written, because ${plural(keptAsText, 'it', 'they')} cannot be a mark here.` : '',
    attachments ? `${attachments} ${plural(attachments, 'image or PDF was', 'images or PDFs were')} copied into ${into}.` : '',
    missing.length ? `Not found, so not copied: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}.` : '',
    done.some((d) => d.store.title !== 'Wiki') ? 'A book an import list fills is on no shelf: Plugins > Open Imported Book… opens it.' : '',
  ].filter(Boolean);
  const answer = await messageBox({
    type: 'info', message: `${n} page${n === 1 ? ' is' : 's are'} in ${into}.`, detail: said.join(' '),
    buttons: [...done.map((d) => (d.store.title === 'Wiki' ? 'Open Wiki Book' : `Open ${d.store.title}`)), 'Close'],
    defaultId: 0, cancelId: done.length, noLink: true,
  });
  const chosenBook = done[answer.response];
  return {
    outcome: 'imported',
    bookId: done[0]!.applied.bookId,
    imported: done.flatMap((d) => d.applied.imported),
    open: chosenBook?.store.title === 'Wiki',
    openBookId: chosenBook && chosenBook.store.title !== 'Wiki' ? chosenBook.applied.bookId : null,
  };
}

// The wiki's store, and one for each other book an import list names, made when first asked for.
class Stores {
  readonly wiki: WikiStore;
  readonly #others = new Map<string, WikiStore>();
  readonly #make: (book?: string) => WikiStore;

  constructor(make: (book?: string) => WikiStore) {
    this.#make = make;
    this.wiki = make();
  }

  for(book: string | null): WikiStore {
    if (book === null) return this.wiki;
    let store = this.#others.get(key(book));
    if (!store) this.#others.set(key(book), store = this.#make(book));
    return store;
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

export function startWiki(host: NeoMainHost, layer: GitLayer, marks: MarkStore): WikiStore {
  const stores = new Stores((book) => new WikiStore({
    library: () => host.paths.library(),
    marks,
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    commit: (part) => layer.commitNow(part === 'author' ? 'import-author' : 'import'),
    log: host.log.bind(host),
    ...(book === undefined ? {} : { book }),
  }));
  const wiki = stores.wiki;
  host.handle('wiki.pages', () => wiki.pages());
  host.handle('wiki.page', (payload) => wiki.page(checked('wiki.page', validateHoardWikiPageV1, payload).chId));
  host.handle('wiki.import', (payload) => {
    const { openBookId, from = 'pages' } = checked('wiki.import', validateHoardWikiImportV1, payload);
    return runImport(host, stores, from, openBookId);
  });
  host.handle('wiki.imported-book', () => pickImportedBook(host));
  return wiki;
}
