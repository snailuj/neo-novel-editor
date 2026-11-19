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
// Every channel that has moved behind the store is driven against a temp library holding a
// book, a chapter, notes, a snapshot and a sidecar; any recorded path inside the library
// fails the test.

const root = path.join(import.meta.dirname, '..', '..', '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const localRequire = createRequire(path.join(root, 'main.js'));

// Channels that still open library files in main.js. Step 3 of the storage plan moves them
// into the store and empties this list; until then a channel named here is allowed to be
// seen, and one missing from the list that opens a library file is a failure.
const pendingChannels: string[] = [
  'library:pocket', 'library:usePocket', // folder choice, move, Pocket
  'cover:pick', 'cover:set', 'cover:remove', 'cover:read', 'cover:paint', // covers and art
  'email:draft', // the draft goes into Exports/
  'log:error', // the library's error log
];

const NAMES = ['library:read', 'library:write', 'library:listBooks', 'book:create', 'book:duplicate', 'book:readMeta',
  'book:writeMeta', 'chapter:stamps', 'chapter:read', 'chapter:write', 'chapter:delete', 'aux:read', 'aux:write',
  'snapshot:list', 'snapshot:read', 'snapshot:write', 'snapshot:remove', 'json:read', 'json:write', 'book:delete',
  'spell:setLanguage'];

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

const inside = (library: string, p: string) => {
  const rel = path.relative(library, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function loadMain(seen: Seen[]) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const trashed: string[] = [];
  const spellLoads: unknown[] = [];
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: () => os.tmpdir(),
      getLocale: () => 'en',
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }),
      on() {},
    },
    ipcMain: { on() {}, handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items: unknown) => items, setApplicationMenu() {} },
    dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) },
    shell: { trashItem: async (dir: string) => { trashed.push(dir); }, showItemInFolder() {} },
    utilityProcess: {
      fork: () => {
        let receive: (m: unknown) => void = () => {};
        return {
          on: (name: string, fn: (m: unknown) => void) => { if (name === 'message') receive = fn; },
          postMessage: (m: { id: number }) => { spellLoads.push(m); queueMicrotask(() => receive({ id: m.id, ok: true })); },
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
    require: (name: string) => (name === 'electron' ? electron : name in proxied ? proxied[name] : localRequire(name)),
    __dirname: root,
    process: { platform: process.platform, on() {} },
    console,
    libraryRoot: os.tmpdir(),
  });
  vm.runInContext(source, context, { filename: path.join(root, 'main.js') });
  return {
    trashed,
    spellLoads,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args) as Promise<any>,
    has: (name: string) => handlers.has(name),
    pointAt(dir: string) {
      context.libraryRoot = dir;
      vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);
    },
    run: (code: string) => vm.runInContext(code, context),
  };
}

test('the recorder sees a path given to fs, so a clean run means something', () => {
  const seen: Seen[] = [];
  const f = recordingFs(fs, seen);
  const probe = path.join(os.tmpdir(), 'neo-no-such-file-' + process.pid);
  assert.equal(f.existsSync(probe), false);
  assert.throws(() => f.readFileSync(probe));
  assert.deepEqual(seen.map((s) => s.fn), ['fs.existsSync', 'fs.readFileSync']);
  assert.equal(seen[0].path, probe);
});

test('every channel that has moved behind the store reaches the library only through it', async () => {
  const seen: Seen[] = [];
  const main = loadMain(seen);
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-guard-'));
  try {
    for (const name of [...NAMES, ...pendingChannels]) assert.ok(main.has(name), `${name} is a channel`);
    main.pointAt(library);
    seen.length = 0; // what main.js did while loading is not a channel
    const direct: Seen[] = [];
    const sweep = () => { direct.push(...seen.filter((s) => inside(library, s.path))); seen.length = 0; };

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
    await main.call('library:write', lib);
    await main.call('library:listBooks');
    const copy = await main.call('book:duplicate', book.id, 'Guard copy');
    await main.call('snapshot:remove', book.id, snap);
    await main.call('chapter:delete', book.id, 'c1');
    assert.equal(await main.call('book:delete', copy.id, 'Guard copy'), true);
    assert.deepEqual(main.trashed, [path.join(library, copy.id)]);
    // the spell checker reads library.json for the dictionary language and the words learnt
    sweep();
    fs.writeFileSync(path.join(library, 'library.json'), JSON.stringify({ ...lib, spellLanguage: 'fr', customWords: ['Zorn'] }));
    await main.run('initSpell()');
    assert.equal(await main.call('spell:setLanguage', 'de'), true);
    assert.ok(main.spellLoads.length >= 2, 'the dictionary was asked for');

    sweep();
    assert.deepEqual(direct, [], 'main.js opened these library files itself');
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('the fs that main.js is given is the recording one', async () => {
  const seen: Seen[] = [];
  const main = loadMain(seen);
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-guard-'));
  try {
    main.pointAt(library);
    seen.length = 0;
    // a handler's read, as a stand-in for one that was never moved
    main.run('fs.existsSync(LIBRARY_FILE)');
    assert.ok(seen.some((s) => inside(library, s.path)));
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});
