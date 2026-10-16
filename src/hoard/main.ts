// hoard's main half, which plugins-main.js starts once NEO's window is up. It answers the
// window half's health check (ping), and keeps the library's history in git: every
// landed write feeds the checkpoints, the window asks for one on a chapter switch or a
// book closing, and quitting makes one last commit. It keeps the writer's marks in
// sidecars under .neo/, which the history commits with the chapters, brings hoard's
// Markdown pages into the wiki book, searches the library's files, and reads each
// chapter the writer leaves for wiki pages it names (companion/). The library's
// repository is looked at after activate returns, so NEO's start never waits on git.
// Every commit runs the pre-commit gate (git/gate.ts) over what it stages.
import { app, BrowserWindow, dialog, utilityProcess } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardPingV1 } from '../generated/ipc/hoard-ping-v1.js';
import {
  validateHoardGitBlameV1, validateHoardGitCheckpointV1, validateHoardMarksAddV1, validateHoardMarksListV1,
  validateHoardMarksReplyV1, validateHoardMarksStateV1, validateHoardPingV1, validateHoardSearchQueryV1,
} from '../generated/validators.cjs';
import { checked } from './checked.ts';
import { startCompanion } from './companion/main.ts';
import { textconvCommand } from './git/blame.ts';
import { startGate } from './git/gate-main.ts';
import { GitLayer, resolveSettings } from './git/layer.ts';
import { startLibrarianPairs } from './git/librarian-main.ts';
import { createGit } from './git/runner.ts';
import { ATTRIBUTES } from './git/start.ts';
import { MarkStore } from './marks/store.ts';
import { startReview } from './review/main.ts';
import { SearchClient, type WorkerProcess } from './search/client.ts';
import { startWiki } from './wiki/start.ts';

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

// Search: the library's files are read in a worker process, started on the first
// search; the window searches the open book itself and asks here for the rest.
function startSearch(host: NeoMainHost): void {
  const client = new SearchClient({
    start: () => utilityProcess.fork(path.join(host.paths.plugin, 'search-worker.cjs'), [], { serviceName: 'NEO search' }) as unknown as WorkerProcess,
    library: () => host.paths.library(),
    log: host.log.bind(host),
  });
  host.handle('search.query', (payload) => client.search(checked('search.query', validateHoardSearchQueryV1, payload)));
  app.on('will-quit', () => client.stop());
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
  startGate(host, layer);
  startLibrarianPairs(host, layer);
  const marks = startMarks(host, layer);
  const wiki = startWiki(host, layer, marks);
  startCompanion(host, layer, marks, wiki);
  startReview(host, marks);
  startSearch(host);
  layer.open().catch((err: unknown) => host.log('error', 'git.open failed', String(err)));
}
