// The wiki's main half: Import to Wiki asks for Markdown files, Import List to Wiki for
// an import list naming them (import-list.ts), and both say what would come in and
// import on the writer's word; the window asks for the pages to follow links and for one
// page to show in the wiki pane. The questions are OS message boxes, never while the
// writer types: the writer chose the command.
import { BrowserWindow, dialog } from 'electron';
import { readFileSync } from 'node:fs';
import { validateHoardWikiImportV1, validateHoardWikiPageV1 } from '../../generated/validators.cjs';
import { checked } from '../checked.ts';
import type { GitLayer } from '../git/layer.ts';
import type { MarkStore } from '../marks/store.ts';
import { ListError, readImportList, type ImportList } from './import-list.ts';
import { WikiStore, type Pick } from './store.ts';
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
async function choose(from: 'pages' | 'list', host: NeoMainHost): Promise<{ picks: Pick[]; left: ImportList['left'] } | { failed: string } | null> {
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
    return { picks: list.entries.map(({ path, name, section }) => ({ path, name, section })), left: list.left };
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

async function runImport(host: NeoMainHost, wiki: WikiStore, from: 'pages' | 'list', openBookId: string | null) {
  const chosen = await choose(from, host);
  if (chosen === null) return { outcome: 'cancelled' };
  if ('failed' in chosen) return { outcome: 'failed', message: chosen.failed };
  const sorted = wiki.sort(chosen.picks);
  const summary = describeSort(sorted);
  const left = chosen.left.length
    ? `\n\nLeft out by the list: ${chosen.left.slice(0, 12).map((l) => `${l.path} (${l.why})`).join(', ')}${chosen.left.length > 12 ? ` and ${chosen.left.length - 12} more` : ''}.`
    : '';
  if (summary.count === 0) {
    await messageBox({ type: 'info', message: summary.message, detail: summary.detail + left });
    return { outcome: 'nothing' };
  }
  const wikiId = wiki.wikiId();
  if (wikiId !== null && wikiId === openBookId) {
    await messageBox({ type: 'info', message: 'The wiki is open, so nothing was imported.', detail: 'Go back to the shelf and import again. NEO writes the open book\'s page list itself, and would write over the new pages.' });
    return { outcome: 'wiki-open' };
  }
  const asked = await messageBox({
    type: 'question', message: summary.message, detail: summary.detail + left,
    buttons: [`Import ${summary.count} Page${summary.count === 1 ? '' : 's'}`, 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (asked.response !== 0) return { outcome: 'cancelled' };
  let applied;
  try {
    applied = await wiki.apply(sorted, openBookId);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    host.log('error', 'wiki.import failed', why);
    await messageBox({ type: 'warning', message: 'The import stopped.', detail: `${why}\n\nWhat was written stays, and importing the same files again finishes it.` });
    return { outcome: 'failed', message: why };
  }
  const n = applied.imported.length + applied.updated.length;
  const said = [
    applied.updated.length ? `${applied.updated.length} ${plural(applied.updated.length, 'page was', 'pages were')} updated from a newer source.` : '',
    applied.marks ? `${applied.marks} ${plural(applied.marks, 'mark', 'marks')} came with them.` : '',
    applied.keptAsText ? `${applied.keptAsText} CriticMarkup ${plural(applied.keptAsText, 'mark stays', 'marks stay')} in the text as written, because ${plural(applied.keptAsText, 'it', 'they')} cannot be a mark here.` : '',
    applied.attachments ? `${applied.attachments} ${plural(applied.attachments, 'image or PDF was', 'images or PDFs were')} copied into the wiki.` : '',
    applied.missing.length ? `Not found, so not copied: ${applied.missing.slice(0, 12).join(', ')}${applied.missing.length > 12 ? ` and ${applied.missing.length - 12} more` : ''}.` : '',
  ].filter(Boolean);
  const done = await messageBox({
    type: 'info', message: `${n} page${n === 1 ? ' is' : 's are'} in the wiki.`, detail: said.join(' '),
    buttons: ['Open Wiki Book', 'Close'], defaultId: 0, cancelId: 1, noLink: true,
  });
  return { outcome: 'imported', bookId: applied.bookId, imported: applied.imported, open: done.response === 0 };
}

export function startWiki(host: NeoMainHost, layer: GitLayer, marks: MarkStore): WikiStore {
  const wiki = new WikiStore({
    library: () => host.paths.library(),
    marks,
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    commit: (part) => layer.commitNow(part === 'author' ? 'import-author' : 'import'),
    log: host.log.bind(host),
  });
  host.handle('wiki.pages', () => wiki.pages());
  host.handle('wiki.page', (payload) => wiki.page(checked('wiki.page', validateHoardWikiPageV1, payload).chId));
  host.handle('wiki.import', (payload) => {
    const { openBookId, from = 'pages' } = checked('wiki.import', validateHoardWikiImportV1, payload);
    return runImport(host, wiki, from, openBookId);
  });
  return wiki;
}
