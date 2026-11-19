import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

// Rule: no code outside the store module opens a library file.
//
// main.js is loaded in a vm whose `fs` records every path it is given. The store module is
// loaded through the real require with the real fs, so only main.js's own calls are seen.
// Every channel is driven against a temp library holding a book, a chapter, notes, a snapshot,
// a sidecar and a cover, and so are the start-up path and the folder move, choice and Pocket
// functions; any recorded path inside a library folder fails the test. A folder the writer
// moves to is a library folder too, so those are watched as well.

const root = path.join(import.meta.dirname, '..', '..', '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const localRequire = createRequire(path.join(root, 'main.js'));

const NAMES = ['library:read', 'library:write', 'library:listBooks', 'book:create', 'book:duplicate', 'book:readMeta',
  'book:writeMeta', 'chapter:stamps', 'chapter:read', 'chapter:write', 'chapter:delete', 'aux:read', 'aux:write',
  'snapshot:list', 'snapshot:read', 'snapshot:write', 'snapshot:remove', 'json:read', 'json:write', 'book:delete',
  'spell:setLanguage', 'cover:pick', 'cover:set', 'cover:read', 'cover:remove', 'cover:paint', 'email:draft',
  'log:error', 'library:pocket', 'library:usePocket', 'library:path'];

type Seen = { fn: string; path: string };

// A stand-in for an fs module: every function passes through, and every absolute path it is
// given as an argument is written down with the name of the function that was given it.
function recordingFs<T extends object>(real: T, seen: Seen[], name = 'fs'): T {
  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'constants') return value;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          for (const arg of args) {
            const p = arg instanceof URL ? arg.pathname : Buffer.isBuffer(arg) ? arg.toString() : arg;
            if (typeof p === 'string' && path.isAbsolute(p)) seen.push({ fn: `${name}.${String(prop)}`, path: p });
          }
          return value.apply(target, args);
        };
      }
      if (value && typeof value === 'object') return recordingFs(value, seen, `${name}.${String(prop)}`);
      return value;
    },
  });
}

const insideOf = (folder: string, p: string) => {
  const rel = path.relative(folder, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// A computer: a home with Documents, the app's own folder, NEO Pocket's folder in iCloud Drive
// (so the Pocket offers appear) and a folder the writer can move to.
function computer() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-guard-'));
  const home = path.join(base, 'home');
  const docs = path.join(home, 'Documents');
  const userData = path.join(base, 'userData');
  const library = path.join(docs, 'NEO Library');
  const pocket = path.join(home, 'Library', 'Mobile Documents', 'iCloud~com~hughhowey~neo~pocket', 'Documents', 'NEO Library');
  const dest = path.join(home, 'Dropbox', 'NEO');
  for (const dir of [docs, userData, library, path.dirname(pocket)]) fs.mkdirSync(dir, { recursive: true });
  return { base, home, docs, userData, library, pocket, dest, libraries: [library, pocket, dest], done: () => fs.rmSync(base, { recursive: true, force: true }) };
}
type Computer = ReturnType<typeof computer>;

type Timer = { fn: () => unknown; ms: number };

function loadMain(seen: Seen[], pc: Computer, platform = 'darwin') {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const trashed: string[] = [];
  const spellLoads: unknown[] = [];
  const forked: string[] = [];
  const timers: Timer[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const did = { relaunch: 0, exit: 0 };
  const answers = { async: [] as number[], sync: [] as number[] };
  const art = { paintCover: async () => ({ buffer: Buffer.from('painted'), ext: 'png', brief: 'a brief', textModel: 't', imageModel: 'i' }) };
  const timer = () => ({ unref() {} });
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: (name: string) => ({ home: pc.home, userData: pc.userData, documents: pc.docs, temp: os.tmpdir() } as Record<string, string>)[name] ?? os.tmpdir(),
      getLocale: () => 'en',
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }),
      on() {},
      relaunch: () => { did.relaunch++; },
      exit: () => { did.exit++; },
    },
    ipcMain: { on() {}, handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items: unknown) => items, setApplicationMenu() {} },
    dialog: {
      // (the window, when there is one, comes first)
      showMessageBox: (...args: { message?: string }[]) => { asked.push(args.at(-1)?.message ?? ''); return Promise.resolve({ response: answers.async.shift() ?? 0 }); },
      showMessageBoxSync: () => answers.sync.shift() ?? 2,
      showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [pc.dest] }),
      showOpenDialogSync: () => [pc.dest],
    },
    shell: {
      trashItem: async (dir: string) => { trashed.push(dir); },
      showItemInFolder() {},
      openExternal: async (url: string) => { opened.push(url); },
    },
    safeStorage: { isEncryptionAvailable: () => false },
    utilityProcess: {
      fork: (script: string) => {
        forked.push(script);
        let receive: (m: unknown) => void = () => {};
        return {
          on: (name: string, fn: (m: unknown) => void) => { if (name === 'message') receive = fn; },
          // the spell checker's dictionary and the backup both answer ok
          postMessage: (m: { id: number }) => { spellLoads.push(m); queueMicrotask(() => receive({ id: m.id, ok: true })); },
          kill() {},
        };
      },
    },
    screen: {},
  };
  const realFs = recordingFs(fs, seen);
  const proxied: Record<string, unknown> = {
    fs: realFs, 'node:fs': realFs, 'fs/promises': recordingFs(fs.promises, seen, 'fsp'), 'node:fs/promises': recordingFs(fs.promises, seen, 'fsp'),
  };
  const context = vm.createContext({
    require: (name: string) => (name === 'electron' ? electron : name === './art.js' ? art : name in proxied ? proxied[name] : localRequire(name)),
    __dirname: root,
    process: { platform, on() {}, env: {} },
    console,
    // timers that wait for the test to run them, so nothing starts on its own
    setTimeout: (fn: () => unknown, ms: number) => { timers.push({ fn, ms }); return timer(); },
    setInterval: (fn: () => unknown, ms: number) => { timers.push({ fn, ms }); return timer(); },
    clearTimeout() {},
    libraryRoot: pc.library,
  });
  vm.runInContext(source, context, { filename: path.join(root, 'main.js') });
  return {
    trashed, spellLoads, forked, timers, opened, asked, did, answers, art,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args) as Promise<any>,
    has: (name: string) => handlers.has(name),
    pointAt(dir: string) {
      context.libraryRoot = dir;
      vm.runInContext('LIBRARY_DIR = libraryRoot;', context);
    },
    run: (code: string) => vm.runInContext(code, context),
    dir: () => vm.runInContext('LIBRARY_DIR', context) as string,
    source: () => source,
  };
}

const sweep = (seen: Seen[], libraries: string[]) => {
  const direct = seen.filter((s) => libraries.some((l) => insideOf(l, s.path)));
  seen.length = 0;
  return direct;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the recorder sees a path given to fs, so a clean run means something', () => {
  const seen: Seen[] = [];
  const f = recordingFs(fs, seen);
  const probe = path.join(os.tmpdir(), 'neo-no-such-file-' + process.pid);
  assert.equal(f.existsSync(probe), false);
  assert.throws(() => f.readFileSync(probe));
  assert.deepEqual(seen.map((s) => s.fn), ['fs.existsSync', 'fs.readFileSync']);
  assert.equal(seen[0].path, probe);
});

test('the fs that main.js is given is the recording one', () => {
  const seen: Seen[] = [];
  const pc = computer();
  try {
    const main = loadMain(seen, pc);
    seen.length = 0;
    // a handler's read, as a stand-in for one that was never moved
    main.run('fs.existsSync(LIBRARY_DIR)');
    assert.ok(sweep(seen, pc.libraries).length > 0);
  } finally { pc.done(); }
});

test('every channel reaches the library only through the store', async () => {
  const seen: Seen[] = [];
  const pc = computer();
  try {
    const main = loadMain(seen, pc);
    for (const name of NAMES) assert.ok(main.has(name), `${name} is a channel`);
    main.pointAt(pc.library);
    seen.length = 0; // what main.js did while loading is not a channel
    const direct: Seen[] = [];
    const check = () => direct.push(...sweep(seen, pc.libraries));

    const lib = await main.call('library:read');
    const book = await main.call('book:create', { title: 'Guard', author: 'Ada' });
    await main.call('chapter:write', book.id, 'c1', '<p>one two</p>');
    await main.call('chapter:write', book.id, 'c1', '<p>one two three</p>', '<p>one two</p>');
    await main.call('chapter:read', book.id, 'c1');
    await main.call('chapter:stamps', book.id);
    await main.call('aux:write', book.id, 'notes', '<p>note</p>');
    await main.call('aux:write', book.id, 'notes', '<p>note two</p>', '<p>note</p>');
    await main.call('aux:read', book.id, 'notes');
    await main.call('json:write', book.id, 'darlings', [{ text: 'cut' }]);
    await main.call('json:read', book.id, 'darlings', []);
    const snap = '20261001T000000Z-d-1-10-aaaa';
    await main.call('snapshot:write', book.id, snap, 'c1.html', '<p>one two</p>');
    await main.call('snapshot:write', book.id, snap, 'snapshot.json', '{}');
    await main.call('snapshot:list', book.id);
    await main.call('snapshot:read', book.id, snap, 'c1.html');
    book.chapterOrder = ['c1'];
    await main.call('book:writeMeta', book.id, book, ['c1']);
    await main.call('book:readMeta', book.id);
    lib.shelves[0].bookIds.push(book.id);
    lib.firstRunDone = true;
    await main.call('library:write', lib);
    await main.call('library:listBooks');
    const copy = await main.call('book:duplicate', book.id, 'Guard copy');

    // covers and the painting
    const image = path.join(fs.mkdtempSync(path.join(pc.base, 'img-')), 'cover.png');
    fs.writeFileSync(image, 'png');
    assert.equal(await main.call('cover:pick'), pc.dest, 'the picker answers the path it was given');
    const cover = await main.call('cover:set', book.id, image);
    assert.equal((await main.call('cover:read', book.id, cover)).mime, 'image/png');
    assert.equal(await main.call('cover:remove', book.id), true);
    fs.writeFileSync(path.join(pc.userData, 'secrets.json'), JSON.stringify({ openai: { enc: false, value: 'a-key' } }));
    const painted = await main.call('cover:paint', book.id, 'the story so far', {});
    assert.match(painted.file, /^art-\d+\.png$/);
    assert.equal((await main.call('cover:read', book.id, painted.file)).ext, 'png');

    // the error log, and the export beside the books
    await main.call('log:error', 'a renderer error');
    main.run('renderPDF = async () => Buffer.from("%PDF-guard")');
    const draft = await main.call('email:draft', { to: 'me@example.com', subject: 's', body: 'b', html: '<p>x</p>', defaultName: 'Guard', method: 'gmail' });
    assert.equal(draft.ok, true);
    assert.equal(fs.readFileSync(draft.file, 'utf8'), '%PDF-guard');
    await main.call('snapshot:remove', book.id, snap);
    await main.call('chapter:delete', book.id, 'c1');
    main.answers.async.push(1); // Move to Trash
    assert.equal(await main.call('book:delete', copy.id, 'Guard copy'), true);
    assert.deepEqual(main.trashed, [path.join(pc.library, copy.id)]);
    assert.equal(await main.call('library:path'), pc.library);

    // the day's backup and the look at iCloud, as the timers start them
    await main.run('dailyBackup()');
    assert.equal(main.forked.at(-1), path.join(root, 'backup-worker.js'), 'the store forks the backup worker');
    await main.run('fetchLibraryFromICloud()');

    // the spell checker reads library.json for the dictionary language and the words learnt
    check();
    fs.writeFileSync(path.join(pc.library, 'library.json'), JSON.stringify({ ...lib, spellLanguage: 'fr', customWords: ['Zorn'] }));
    await main.run('initSpell()');
    assert.equal(await main.call('spell:setLanguage', 'de'), true);
    assert.ok(main.spellLoads.length >= 2, 'the dictionary was asked for');
    seen.length = 0;
    fs.writeFileSync(path.join(pc.library, 'library.json'), JSON.stringify(lib));

    // NEO Pocket's folder, the folder choice and the move, with the writer's answers
    assert.deepEqual({ ...(await main.call('library:pocket')) }, { offer: true, books: false }, 'the Pocket folder is here, with no books in it yet');
    main.answers.async.push(1); // Not Now
    await main.run('askAboutPocket()');
    main.answers.async.push(2); // OK
    await main.run('showPocketInfo()');
    assert.equal(await main.call('library:usePocket'), true);
    assert.ok(fs.existsSync(path.join(pc.pocket, book.id, 'book.json')), 'the books are in the Pocket folder');
    assert.deepEqual(main.trashed.at(-1), pc.library, 'and the old folder went to the Trash');
    main.answers.async.push(1, 0); // Choose Folder…, then Move Books
    await main.run('chooseLibraryFolder()');
    assert.ok(fs.existsSync(path.join(pc.dest, book.id, 'book.json')), 'and into the folder the writer picked');
    assert.equal(main.did.relaunch, 2);
    check();

    assert.deepEqual(direct, [], 'main.js opened these library files itself');
  } finally { pc.done(); }
});

test('start-up opens the library through the store: the folder is found, probed, made and the chores scheduled', async () => {
  const seen: Seen[] = [];
  const pc = computer();
  try {
    const chosen = path.join(pc.base, 'Chosen');
    fs.mkdirSync(chosen);
    fs.writeFileSync(path.join(pc.userData, 'settings.json'), JSON.stringify({ libraryDir: chosen }));
    const main = loadMain(seen, pc, 'linux');
    seen.length = 0;
    main.run('resolveLibraryDir()');
    assert.equal(main.dir(), chosen);
    main.run('openLibrary()');
    await tick();
    assert.ok(fs.existsSync(path.join(chosen, 'library.json')), 'a new library is made');
    assert.equal(main.answers.sync.length, 0);
    main.run('scheduleLibraryChores()');
    assert.deepEqual(main.timers.map((t) => t.ms), [2500, 120000, 3600000, 60000], 'the Pocket look, the backup, the hourly look, the iCloud walk');
    for (const timer of main.timers) await timer.fn();
    await tick();
    assert.equal(main.forked.at(-1), path.join(root, 'backup-worker.js'));
    // and the library is open, so an error goes into its own log
    main.run('logError("guard", new Error("an error once open"))');
    await tick();
    assert.match(fs.readFileSync(path.join(chosen, 'neo-errors.log'), 'utf8'), /an error once open/);
    assert.deepEqual(sweep(seen, [chosen]), [], 'main.js opened these library files itself');
  } finally { pc.done(); }
});

test('a first library that Documents cannot hold goes beside it, and a folder that is not there is asked about, all through the store', async () => {
  const seen: Seen[] = [];
  const pc = computer();
  try {
    // "Documents" below a file cannot be written in
    const gone = path.join(pc.base, 'OneDrive');
    fs.writeFileSync(gone, 'not a folder');
    const docs = path.join(gone, 'Documents');
    const main = loadMain(seen, { ...pc, docs }, 'linux');
    seen.length = 0;
    main.run('resolveLibraryDir()');
    main.run('openLibrary()');
    await tick();
    assert.equal(main.dir(), path.join(pc.home, 'Documents', 'NEO Library'));
    assert.ok(fs.existsSync(path.join(main.dir(), 'library.json')));
    main.run('announceLibraryFallback()');
    assert.equal(main.asked.length, 1);

    // a chosen folder that has gone away: Try Again, then Continue
    fs.writeFileSync(path.join(pc.userData, 'settings.json'), JSON.stringify({ libraryDir: path.join(pc.base, 'NAS', 'NEO') }));
    main.answers.sync.push(0, 2);
    main.run('resolveLibraryDir()');
    assert.equal(main.dir(), path.join(docs, 'NEO Library'), 'Continue is the default folder, for this session');
    assert.deepEqual(sweep(seen, [path.join(pc.home, 'Documents', 'NEO Library'), path.join(pc.base, 'NAS')]), [], 'main.js opened these library files itself');
  } finally { pc.done(); }
});

test('a chapter read that finds no file rejects but adds nothing to the error log; any other failure is logged', async () => {
  const pc = computer();
  try {
    const main = loadMain([], pc, 'linux');
    main.pointAt(pc.library);
    await main.run('libraryStore().open()');
    const book = await main.call('book:create', { title: 'Log' });
    const logFile = path.join(pc.library, 'neo-errors.log');
    await assert.rejects(main.call('chapter:read', book.id, 'not-written-yet'), /\[store:not_found\]/);
    await assert.rejects(main.call('aux:read', book.id, '../notes'), /\[store:bad_name\]/);
    await tick();
    const log = fs.readFileSync(logFile, 'utf8');
    assert.doesNotMatch(log, /ipc chapter:read/, 'a chapter that is not there yet is not an error to log');
    assert.match(log, /ipc aux:read/, 'a name that is no name is');
  } finally { pc.done(); }
});

test('an error logged while the library is not open goes to the app\'s own folder, and makes no library', async () => {
  const pc = computer();
  try {
    const missing = path.join(pc.base, 'Not', 'Yet', 'NEO Library');
    const main = loadMain([], pc, 'linux');
    main.pointAt(missing);
    main.run('logError("early", new Error("before the library is found"))');
    await tick();
    assert.equal(fs.existsSync(path.dirname(path.dirname(missing))), false, 'no folder was made for a log line');
    assert.match(fs.readFileSync(path.join(pc.userData, 'neo-errors.log'), 'utf8'), /before the library is found/);
    // opened, then gone: the line still goes to the app's own folder, and the library is not made again
    fs.mkdirSync(missing, { recursive: true });
    await main.run('libraryStore().open()');
    fs.rmSync(path.join(pc.base, 'Not'), { recursive: true });
    main.run('logError("late", new Error("after the folder went away"))');
    await tick();
    assert.equal(fs.existsSync(path.join(pc.base, 'Not')), false);
    assert.match(fs.readFileSync(path.join(pc.userData, 'neo-errors.log'), 'utf8'), /after the folder went away/);
  } finally { pc.done(); }
});

test('main.js names no library file and holds no way round the store', () => {
  // the shared iCloud and JSON helpers are for settings, secrets and a picked manuscript;
  // nothing here may be a path to a library file, or the back door the store used to have
  const text = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  for (const banned of ['ensureLibrary', 'LIBRARY_FILE', 'cloudOnlyAmong', 'afterLocal', 'libraryStore().root', 'bookDir(']) {
    assert.equal(text.includes(banned), false, `main.js mentions ${banned}`);
  }
  assert.doesNotMatch(text, /path\.join\(LIBRARY_DIR/, 'no path is joined onto the library folder');
});
