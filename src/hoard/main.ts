// hoard's main half, which plugins-main.js starts once NEO's window is up. It answers the
// window half's health check (ping), and keeps the library's history in git: every
// landed write feeds the checkpoints, the window asks for one on a chapter switch or a
// book closing, and quitting makes one last commit. It keeps the writer's marks in
// sidecars under .neo/, which the history commits with the chapters, and brings hoard's
// Markdown pages into the wiki book. The library's repository is looked
// at after activate returns, so NEO's start never waits on git.
import { app, BrowserWindow, dialog } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardPingV1 } from '../generated/ipc/hoard-ping-v1.js';
import {
  validateHoardGitBlameV1, validateHoardGitCheckpointV1, validateHoardMarksAddV1, validateHoardMarksListV1,
  validateHoardMarksReplyV1, validateHoardMarksStateV1, validateHoardPingV1, validateHoardWikiImportV1,
} from '../generated/validators.cjs';
import { textconvCommand } from './git/blame.ts';
import { GitLayer, resolveSettings } from './git/layer.ts';
import { createGit } from './git/runner.ts';
import { ATTRIBUTES } from './git/start.ts';
import { MarkStore } from './marks/store.ts';
import { WikiStore } from './wiki/store.ts';
import { describeSort } from './wiki/summary.ts';

function checked<T>(name: string, validate: { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null }, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

function ping(payload: unknown): HoardPingV1 {
  return checked('ping', validateHoardPingV1, payload);
}

// git's child processes cannot read inside app.asar; the build unpacks the textconv.
function unpacked(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function settingsOf(host: NeoMainHost): unknown {
  try {
    return host.settings.get();
  } catch (err) {
    host.log('warn', 'hoard could not read its settings, so the git defaults apply', String(err));
    return {};
  }
}

function startHistory(host: NeoMainHost): GitLayer {
  const own = path.join(host.paths.userData, 'hoard');
  const hooksPath = path.join(own, 'git-hooks');
  mkdirSync(hooksPath, { recursive: true });
  const attributesFile = path.join(own, 'gitattributes');
  writeFileSync(attributesFile, `${ATTRIBUTES}\n`);
  const settings = resolveSettings(settingsOf(host), (message) => host.log('warn', message));
  const log = host.log.bind(host);
  const layer = new GitLayer({
    git: createGit({ git: settings.gitPath ?? undefined, hooksPath, log }),
    library: host.paths.library(),
    settings,
    attributesFile,
    textconv: textconvCommand(process.execPath, unpacked(path.join(host.paths.plugin, 'textconv.cjs')), {
      ELECTRON_RUN_AS_NODE: '1',
    }),
    log,
  });

  host.onAfterWrite((event) => layer.wrote(event.name));
  host.handle('git.checkpoint', (payload) => {
    layer.request(checked('git.checkpoint', validateHoardGitCheckpointV1, payload).reason);
    return null;
  });
  host.handle('git.blame', (payload) => layer.blame(checked('git.blame', validateHoardGitBlameV1, payload)));
  host.handle('git.status', () => layer.status());
  host.handle('git.keep-history', () => keepHistory(host, layer));

  // One last commit before NEO quits, at most five seconds; whatever it misses is on
  // disk and committed at the next start.
  let closed = false;
  app.on('will-quit', (event) => {
    if (closed || layer.status().state !== 'tracked') return;
    event.preventDefault();
    layer.close(5_000).finally(() => {
      closed = true;
      app.quit();
    });
  });
  return layer;
}

// Marks the writer makes in the window. The window sends ids and words; the store adds
// the time, the commit and who made it, which from this channel is always the author.
function startMarks(host: NeoMainHost, layer: GitLayer): MarkStore {
  const store = new MarkStore({
    library: () => host.paths.library(),
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    log: host.log.bind(host),
  });
  host.handle('marks.list', (payload) => store.list(checked('marks.list', validateHoardMarksListV1, payload).bookId));
  host.handle('marks.add', (payload) => store.add(checked('marks.add', validateHoardMarksAddV1, payload), 'author'));
  host.handle('marks.reply', (payload) => store.reply(checked('marks.reply', validateHoardMarksReplyV1, payload), 'author'));
  host.handle('marks.state', (payload) => store.setState(checked('marks.state', validateHoardMarksStateV1, payload), 'author'));
  return store;
}

function messageBox(options: Electron.MessageBoxOptions) {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

// The wiki: Import to Wiki asks for Markdown files, says what would come in, and imports
// on the writer's word; the window asks for the pages to follow links.
function startWiki(host: NeoMainHost, layer: GitLayer, marks: MarkStore): void {
  const wiki = new WikiStore({
    library: () => host.paths.library(),
    marks,
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    log: host.log.bind(host),
  });
  host.handle('wiki.pages', () => wiki.pages());
  host.handle('wiki.import', async (payload) => {
    const { openBookId } = checked('wiki.import', validateHoardWikiImportV1, payload);
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      title: 'Import to Wiki', buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const pick = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (pick.canceled || pick.filePaths.length === 0) return { outcome: 'cancelled' };
    const sorted = wiki.sort(pick.filePaths);
    const summary = describeSort(sorted);
    if (summary.count === 0) {
      await messageBox({ type: 'info', message: summary.message, detail: summary.detail });
      return { outcome: 'nothing' };
    }
    const wikiId = wiki.wikiId();
    if (wikiId !== null && wikiId === openBookId) {
      await messageBox({ type: 'info', message: 'The wiki is open, so nothing was imported.', detail: 'Go back to the shelf and import again. NEO writes the open book\'s page list itself, and would write over the new pages.' });
      return { outcome: 'wiki-open' };
    }
    const asked = await messageBox({
      type: 'question', message: summary.message, detail: summary.detail,
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
    await layer.commitNow('import');
    const n = applied.imported.length;
    const kept = applied.keptAsText ? ` ${applied.keptAsText} CriticMarkup mark${applied.keptAsText === 1 ? ' stays' : 's stay'} in the text as written, because ${applied.keptAsText === 1 ? 'it' : 'they'} cannot be a mark here.` : '';
    const done = await messageBox({
      type: 'info', message: `${n} page${n === 1 ? ' is' : 's are'} in the wiki.`,
      detail: `${applied.marks ? `${applied.marks} mark${applied.marks === 1 ? '' : 's'} came with them.` : ''}${kept}`.trim(),
      buttons: ['Open Wiki', 'Close'], defaultId: 0, cancelId: 1, noLink: true,
    });
    return { outcome: 'imported', bookId: applied.bookId, imported: applied.imported, open: done.response === 0 };
  });
}

// The writer chose Keep Library History from the Plugins menu, so the answer is theirs
// to read: a message box, never while they type.
async function keepHistory(host: NeoMainHost, layer: GitLayer) {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const show = (type: 'info' | 'warning', message: string, detail: string) =>
    (parent ? dialog.showMessageBox(parent, { type, message, detail }) : dialog.showMessageBox({ type, message, detail }));
  try {
    const before = layer.status().state;
    const started = await layer.keepHistory();
    await show(
      'info',
      before === 'tracked' ? 'This library\'s history is already kept in git.' : 'NEO now keeps this library\'s history in git.',
      `Each pause in your writing is committed in ${host.paths.library()}.`,
    );
    return { started: started.started, commit: started.committed?.commit ?? null };
  } catch (err) {
    await show('warning', 'NEO could not keep this library\'s history.', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function activate(host: NeoMainHost): void {
  host.handle('ping', ping);
  const layer = startHistory(host);
  const marks = startMarks(host, layer);
  startWiki(host, layer, marks);
  layer.open().catch((err: unknown) => host.log('error', 'git.open failed', String(err)));
}
