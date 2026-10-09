'use strict';

// plugins-main.js finds plugin folders (each with a plugin.json) and lists
// their commands in a Plugins menu. It takes Electron's app and ipcMain from
// wire(), so these tests hand it stand-ins and, where a case needs folders of
// its own, a temporary app folder. The last test loads main.js the way
// filesystem.test.js does, to see the menu and the window's list wired up.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { afterEach, describe, test } = require('node:test');

const plugins = require('../plugins-main.js');

const root = path.join(__dirname, '..');
const fixtures = 'scripts/fixtures/plugins';
const envDirs = process.env.NEO_PLUGIN_DIRS;
const made = [];

afterEach(() => {
  if (envDirs === undefined) delete process.env.NEO_PLUGIN_DIRS;
  else process.env.NEO_PLUGIN_DIRS = envDirs;
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

// wires the module to stand-ins; dirs becomes NEO_PLUGIN_DIRS
function wire({ appRoot = root, isPackaged = false, dirs, app = { isPackaged } } = {}) {
  if (dirs === undefined) delete process.env.NEO_PLUGIN_DIRS;
  else process.env.NEO_PLUGIN_DIRS = dirs;
  const logs = [];
  const handlers = new Map();
  plugins.wire({
    app,
    ipcMain: { on: (channel, fn) => handlers.set(channel, fn) },
    logError: (source, err) => logs.push(`[${source}] ${err && err.stack ? err.stack : String(err)}`),
    appRoot
  });
  return { logs, handlers };
}

function tempFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-plugins-'));
  made.push(dir);
  return dir;
}

function addPlugin(dir, rel, manifest) {
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  fs.writeFileSync(path.join(dir, rel, 'plugin.json'), JSON.stringify(manifest));
}

// a temporary app folder with a plugin.json in each named folder
function appFolder(manifests) {
  const dir = tempFolder();
  for (const [rel, manifest] of Object.entries(manifests)) addPlugin(dir, rel, manifest);
  return dir;
}

const plugin = (id, extra) => ({ id, apiVersion: 1, renderer: 'renderer.js', ...extra });
const ids = () => plugins.discover().map((m) => m.id);
const find = (id) => plugins.discover().find((m) => m.id === id);

describe('plugin discovery', { concurrency: 1 }, () => {
  test('the probe is listed with its renderer URL relative to the app folder, on every platform', () => {
    wire({ dirs: fixtures });
    const probe = find('probe');
    assert.ok(probe, 'probe is listed');
    assert.equal(probe.rendererUrl, 'scripts/fixtures/plugins/probe/renderer.js');
    assert.equal(probe.styleUrl, null);
    assert.equal(probe.mainPath, null);
  });

  test('a style gets a URL and a main entry an absolute path', () => {
    const app = appFolder({ 'plugins/full': plugin('full', { main: 'main.cjs', style: 'style.css' }) });
    wire({ appRoot: app });
    const full = find('full');
    assert.equal(full.rendererUrl, 'plugins/full/renderer.js');
    assert.equal(full.styleUrl, 'plugins/full/style.css');
    assert.equal(full.mainPath, path.join(app, 'plugins', 'full', 'main.cjs'));
    assert.ok(path.isAbsolute(full.mainPath));
  });

  test('a manifest that fails the checks, or repeats an id, is skipped and logged with its folder', () => {
    const app = appFolder({
      'plugins/a-good': plugin('good'),
      'plugins/bad-id': plugin('Bad'),
      'plugins/traversal': plugin('traversal', { renderer: '../x.js' }),
      'plugins/api-zero': plugin('api-zero', { apiVersion: 0 }),
      'plugins/no-renderer': { id: 'no-renderer', apiVersion: 1 },
      'plugins/twin-1': plugin('twin'),
      'plugins/twin-2': plugin('twin')
    });
    const { logs } = wire({ appRoot: app });
    assert.deepEqual(ids(), ['good', 'twin']);
    assert.equal(find('twin').rendererUrl, 'plugins/twin-1/renderer.js'); // the first one stays
    for (const name of ['bad-id', 'traversal', 'api-zero', 'no-renderer', 'twin-2']) {
      const folder = path.join(app, 'plugins', name);
      assert.ok(logs.some((line) => line.includes(folder)), `${name} is logged`);
    }
  });

  test('a root on another drive is refused and logged', { skip: process.platform !== 'win32' && 'drive letters are Windows only' }, () => {
    const app = appFolder({});
    const other = (/^z/i.test(app) ? 'Y:' : 'Z:') + '\\plugins';
    const { logs } = wire({ appRoot: app, dirs: other });
    assert.deepEqual(ids(), []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /outside the app folder/);
    assert.ok(logs[0].includes(other));
  });

  test('a root outside the app folder is refused and logged', () => {
    const app = appFolder({});
    const elsewhere = path.join(tempFolder(), 'elsewhere');
    addPlugin(elsewhere, 'out', plugin('out'));
    for (const dirs of [elsewhere, path.relative(app, elsewhere), '..']) {
      const { logs } = wire({ appRoot: app, dirs });
      assert.deepEqual(ids(), [], dirs);
      assert.equal(logs.length, 1, dirs);
      assert.ok(logs[0].includes(path.resolve(app, dirs)), dirs);
    }
  });

  test('a root folder named ..x inside the app folder is accepted', () => {
    const app = appFolder({ '..x/inside': plugin('inside') });
    const { logs } = wire({ appRoot: app, dirs: '..x' });
    assert.deepEqual(ids(), ['inside']);
    assert.equal(find('inside').rendererUrl, '..x/inside/renderer.js');
    assert.deepEqual(logs, []);
  });

  test('the app folder is matched regardless of case on Windows', { skip: process.platform !== 'win32' && 'Windows paths only' }, () => {
    const shouted = root.toUpperCase() === root ? root.toLowerCase() : root.toUpperCase();
    wire({ dirs: path.join(shouted, fixtures) });
    assert.equal(find('probe').rendererUrl, 'scripts/fixtures/plugins/probe/renderer.js');
  });

  test('NEO_PLUGIN_DIRS is ignored in a packaged app', () => {
    wire({ isPackaged: true, dirs: fixtures });
    assert.equal(find('probe'), undefined);
  });

  test('discover reads the folders once, for the menu and the window alike', () => {
    const app = appFolder({ 'plugins/first': plugin('first') });
    const { handlers } = wire({ appRoot: app });
    const list = plugins.discover();
    addPlugin(app, 'plugins/second', plugin('second'));
    assert.equal(plugins.discover(), list);
    assert.deepEqual(list.map((m) => m.id), ['first']);
    const event = {};
    handlers.get('plugins:list')(event);
    assert.deepEqual(event.returnValue, list.map(({ mainPath, ...listed }) => listed));
  });

  test('the window gets each plugin without its main path, which discover keeps', () => {
    const app = appFolder({ 'plugins/full': plugin('full', { main: 'main.cjs' }) });
    const { handlers } = wire({ appRoot: app });
    const event = {};
    handlers.get('plugins:list')(event);
    assert.deepEqual(event.returnValue.map((m) => m.id), ['full']);
    assert.equal(event.returnValue[0].rendererUrl, 'plugins/full/renderer.js');
    assert.ok(!('mainPath' in event.returnValue[0]), 'the window never sees a path on disk');
    assert.equal(find('full').mainPath, path.join(app, 'plugins', 'full', 'main.cjs'));
  });

  test('plugins:list answers [] and logs the stack when discovery throws', () => {
    // the window waits on this answer (sendSync), so a throw must not escape
    const app = { get isPackaged() { throw new Error('discovery broke'); } };
    const { logs, handlers } = wire({ appRoot: appFolder({}), app });
    const event = {};
    handlers.get('plugins:list')(event);
    assert.deepEqual(event.returnValue, []);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /discovery broke\n\s+at /);
  });

  test('a folder whose name cannot go in a URL is skipped and logged with its folder', (t) => {
    // a lone surrogate makes encodeURIComponent throw; a real disk hands Node
    // such a name only rarely, so the folder listing is stood in for
    const app = appFolder({ 'plugins/good': plugin('good') });
    const bundled = path.join(app, 'plugins');
    const odd = path.join(bundled, 'odd\uD800');
    const { readdirSync, readFileSync } = fs;
    t.mock.method(fs, 'readdirSync', (dir, options) => dir === bundled
      ? [...readdirSync(dir, options), { name: path.basename(odd), isDirectory: () => true, isSymbolicLink: () => false }]
      : readdirSync(dir, options));
    t.mock.method(fs, 'readFileSync', (file, ...rest) => file === path.join(odd, 'plugin.json')
      ? JSON.stringify(plugin('odd'))
      : readFileSync(file, ...rest));
    const { logs } = wire({ appRoot: app });
    assert.deepEqual(ids(), ['good']);
    assert.ok(logs.some((line) => line.includes(odd) && line.includes('URIError')), 'the odd folder is logged');
  });

  test('a plugin folder that is a link is skipped and logged with its folder', (t) => {
    // a link can lead outside the app folder, where 'self' no longer holds
    const app = appFolder({ 'plugins/real': plugin('real') });
    const target = path.join(tempFolder(), 'linked');
    addPlugin(target, '.', plugin('linked'));
    const link = path.join(app, 'plugins', 'linked');
    try {
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      t.skip(`this system refused the link: ${err.code}`);
      return;
    }
    const { logs } = wire({ appRoot: app });
    assert.deepEqual(ids(), ['real']);
    assert.ok(logs.some((line) => line.includes(link)), 'the link is logged');
  });
});

describe('the Plugins menu', { concurrency: 1 }, () => {
  test('a Plugins submenu whose Say Hello sends a plugin-command', () => {
    wire({ dirs: fixtures });
    const sent = [];
    const items = plugins.menuItems((msg) => sent.push(msg));
    assert.equal(items.length, 1);
    assert.equal(items[0].label, 'Plugins');
    const hello = items[0].submenu.find((item) => item.label === 'Say Hello');
    assert.ok(hello, 'Say Hello is in the menu');
    hello.click();
    assert.deepEqual(sent, [{ type: 'plugin-command', plugin: 'probe', command: 'hello' }]);
  });

  test('a label passed in names the menu, so main.js can translate it', () => {
    wire({ dirs: fixtures });
    const items = plugins.menuItems(() => {}, 'Modules');
    assert.equal(items[0].label, 'Modules');
  });

  test('no Plugins menu when no plugin has commands', () => {
    const app = appFolder({ 'plugins/quiet': plugin('quiet') });
    wire({ appRoot: app });
    assert.deepEqual(plugins.menuItems(() => {}), []);
  });

  test('main.js answers plugins:list and puts the Plugins menu just before Window', () => {
    process.env.NEO_PLUGIN_DIRS = fixtures;
    const on = new Map();
    let template = null;
    const electron = {
      app: {
        isPackaged: false,
        commandLine: { appendSwitch() {} },
        getPath: () => os.tmpdir(),
        getLocale: () => 'en',
        requestSingleInstanceLock: () => true,
        whenReady: () => ({ then() {} }),
        on() {}
      },
      ipcMain: { on: (channel, fn) => on.set(channel, fn), handle() {} },
      BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
      Menu: { buildFromTemplate: (items) => { template = items; return { items: [] }; }, setApplicationMenu() {} },
      dialog: {},
      utilityProcess: { fork: () => ({ on() {}, postMessage() {} }) },
      screen: {}
    };
    const localRequire = createRequire(path.join(root, 'main.js'));
    const context = vm.createContext({
      require: (name) => name === 'electron' ? electron : localRequire(name),
      __dirname: root,
      process: { platform: process.platform, on() {} },
      console,
      libraryRoot: tempFolder()
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: path.join(root, 'main.js') });
    vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);

    const event = {};
    on.get('plugins:list')(event);
    assert.ok(event.returnValue.some((m) => m.id === 'probe'), 'the window hears of the probe');

    vm.runInContext('buildMenu()', context);
    const labels = template.map((item) => item.label);
    assert.equal(labels.indexOf('Plugins'), labels.indexOf('Window') - 1);

    // the label goes through t(), like the menus around it
    vm.runInContext('NeoI18n.setLocale("fr", { Plugins: "Modules", Window: "Fenêtre" }, {})', context);
    try {
      vm.runInContext('buildMenu()', context);
      const french = template.map((item) => item.label);
      assert.equal(french.indexOf('Modules'), french.indexOf('Fenêtre') - 1);
    } finally {
      vm.runInContext('NeoI18n.setLocale("en", {}, {})', context);
    }
  });
});

describe('the window half', () => {
  // Pocket runs app.js without plugins.js, so each call app.js makes into the
  // plugin host stands behind a check that the host is there
  const unguarded = (source) => source.split(/\r?\n/).flatMap((line, i) => [...line.matchAll(/\bNeoPlugins\./g)]
    .filter((m) => !/\bif \(window\.NeoPlugins(\)| &&)/.test(line.slice(0, m.index)))
    .map(() => `app.js:${i + 1}: ${line.trim()}`));

  test('hooks are guarded: every NeoPlugins call in app.js sits behind window.NeoPlugins', () => {
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    assert.ok((app.match(/\bNeoPlugins\./g) || []).length >= 7, 'app.js calls the plugin host from its hooks');
    assert.deepEqual(unguarded(app), []);
  });

  test('the guard check finds a call left unguarded', () => {
    const source = [
      'if (window.NeoPlugins) NeoPlugins.emit("a");',
      'NeoPlugins.emit("b");',
      'window.NeoPlugins.emit("c");',
      'if (!window.NeoPlugins) NeoPlugins.emit("d");'
    ].join('\n');
    assert.deepEqual(unguarded(source).map((line) => line.split(': ')[0]), ['app.js:2', 'app.js:3', 'app.js:4']);
  });

  // plugins.js in a vm, with window.neo.plugins as given and stand-ins for
  // the page: what it would add to the page, and what it logs. reads stands
  // in for app.js's getters; clock.now is what performance.now() reads.
  function windowHalf(list, reads = {}) {
    const added = [];
    const logged = [];
    const clock = { now: 0 };
    const page = { appendChild: (el) => added.push(el) };
    const context = vm.createContext({
      neo: { plugins: list, logError: (line) => logged.push(line) },
      document: { head: page, body: page, addEventListener() {}, createElement: (tag) => ({ tag }) },
      requestAnimationFrame: () => 1,
      performance: { now: () => clock.now },
      structuredClone
    });
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(root, 'plugins.js'), 'utf8'), context, { filename: 'plugins.js' });
    const getters = { book: () => null, chapterHTML: () => undefined, currentTab: () => 'manuscript', ...reads };
    return { NeoPlugins: context.NeoPlugins, attach: () => context.NeoPlugins.attach(getters), added, logged, clock };
  }

  // the host with one listed plugin, p, registered with activate; neo is
  // the API p was handed
  function withPlugin(activate = () => {}, reads = {}) {
    const host = windowHalf([{ id: 'p', apiVersion: 1, rendererUrl: 'plugins/p/renderer.js', styleUrl: null }], reads);
    host.attach();
    let neo = null;
    host.NeoPlugins.register({ id: 'p', apiVersion: 1, activate(api) { neo = api; return activate(api); } });
    return { ...host, neo };
  }
  // a rejected promise's handlers have run
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  test('no list, one that is not an array, or an empty one: no plugins, and nothing breaks', () => {
    for (const list of [undefined, null, {}, 'probe', []]) {
      const host = windowHalf(list);
      host.attach();
      assert.deepEqual(host.added, [], String(list));
      let activated = false;
      host.NeoPlugins.register({ id: 'probe', apiVersion: 1, activate() { activated = true; } });
      assert.equal(activated, false, String(list));
      assert.match(host.logged[0], /^plugin probe: .*not activated/, String(list));
    }
  });

  test('a listed plugin written for an API this NEO does not know is refused', () => {
    const host = windowHalf([{ id: 'ahead', apiVersion: 3, rendererUrl: 'plugins/ahead/renderer.js', styleUrl: null }]);
    host.attach();
    assert.deepEqual(host.added.map((el) => [el.tag, el.src]), [['script', 'plugins/ahead/renderer.js']]);
    let activated = false;
    host.NeoPlugins.register({ id: 'ahead', apiVersion: 3, activate() { activated = true; } });
    assert.equal(activated, false);
    assert.equal(host.logged.length, 1);
    assert.match(host.logged[0], /^plugin ahead: apiVersion 3\b.*knows 1\b.*not activated/);
  });

  test('a listener that throws, or whose promise rejects, is logged with its stack, and the rest still run', async () => {
    const { NeoPlugins, neo, logged } = withPlugin();
    const calls = [];
    neo.on('chapter-saved', () => { calls.push('throws'); throw new Error('thrown on purpose'); });
    neo.on('chapter-saved', async () => { calls.push('rejects'); throw new Error('rejected on purpose'); });
    neo.on('chapter-saved', () => calls.push('after'));
    NeoPlugins.emit('chapter-saved', { bookId: 'b', chId: 'c' });
    assert.deepEqual(calls, ['throws', 'rejects', 'after']);
    await settled();
    assert.equal(logged.length, 2, logged.join('\n'));
    assert.match(logged[0], /^plugin p: Error: thrown on purpose\n\s+at /);
    assert.match(logged[1], /^plugin p: Error: rejected on purpose\n\s+at /);
  });

  test('a listener that throws what has no text form is logged, and emit never throws', async () => {
    const { NeoPlugins, neo, logged } = withPlugin();
    const calls = [];
    neo.on('chapter-change', () => { calls.push('change'); throw Symbol('change'); });
    neo.on('book-close', () => { calls.push('symbol'); throw Symbol('boom'); });
    neo.on('book-close', () => { calls.push('bare'); throw Object.create(null); });
    neo.on('book-close', async () => { calls.push('rejects'); throw Symbol('later'); });
    // the change waits for a frame, and goes out ahead of the next event
    NeoPlugins.emit('chapter-change', { bookId: 'b', chId: 'c' });
    NeoPlugins.emit('book-close', { bookId: 'b' });
    assert.deepEqual(calls, ['change', 'symbol', 'bare', 'rejects']);
    await settled();
    assert.deepEqual(logged, [
      'plugin p: Symbol(change)',
      'plugin p: Symbol(boom)',
      'plugin p: (a value of type object with no text form)',
      'plugin p: Symbol(later)'
    ]);
  });

  // neo-errors.log sits in the synced library, and a selection listener is
  // called about once a keystroke
  test('a listener that fails every time is logged once, then at most once a minute with a count', async () => {
    const { NeoPlugins, neo, logged, clock } = withPlugin();
    neo.on('chapter-saved', () => { throw new Error('throws every time'); });
    neo.on('chapter-saved', async () => { throw new Error('rejects every time'); });
    const saves = async (n) => {
      for (let i = 0; i < n; i++) NeoPlugins.emit('chapter-saved', { bookId: 'b', chId: 'c' });
      await settled();
    };
    await saves(100);
    assert.equal(logged.length, 2, 'the first failure of each listener');
    assert.match(logged[0], /^plugin p: Error: throws every time\n\s+at /);
    assert.match(logged[1], /^plugin p: Error: rejects every time\n\s+at /);
    clock.now += 59999;
    await saves(10);
    assert.equal(logged.length, 2);
    clock.now += 1;
    await saves(1);
    assert.equal(logged.length, 4);
    assert.match(logged[2], /^plugin p: 109 more failures of this listener since its last line; the latest: Error: throws every time\n\s+at /);
    assert.match(logged[3], /^plugin p: 109 more failures of this listener since its last line; the latest: Error: rejects every time\n\s+at /);
    // a minute with none, and the next is logged as a first
    clock.now += 60000;
    await saves(1);
    assert.equal(logged.length, 6);
    assert.match(logged[4], /^plugin p: Error: throws every time\n/);
  });

  test('book() and a late book-open read only the book the plugins heard open, never one a shelf export borrowed', () => {
    // app.js's book, borrowed by a shelf export: no plugin heard it open
    let book = { id: 'other', chapterOrder: [] };
    const heard = [];
    const { NeoPlugins, neo } = withPlugin((api) => { api.on('book-open', (d) => heard.push(d.bookId)); }, { book: () => book });
    assert.deepEqual(heard, []);
    assert.equal(neo.book(), null);
    book = { id: 'owls', chapterOrder: ['c1'] };
    NeoPlugins.emit('book-open', { bookId: 'owls' });
    assert.deepEqual(neo.book(), book);
    // a book-close listener still reads the closing book; after it, nothing
    let closing = null;
    neo.on('book-close', () => { closing = neo.book(); });
    NeoPlugins.emit('book-close', { bookId: 'owls' });
    assert.deepEqual(closing, book);
    assert.equal(neo.book(), null);
  });

  test('an activate whose promise rejects is logged, and the listeners it added are taken away', async () => {
    let heard = 0;
    const { NeoPlugins, neo, logged } = withPlugin(async (api) => {
      api.on('book-open', () => heard++);
      await null;
      throw new Error('activate rejected on purpose');
    });
    await settled();
    assert.equal(logged.length, 1, logged.join('\n'));
    assert.match(logged[0], /^plugin p: Error: activate rejected on purpose\n\s+at /);
    NeoPlugins.emit('book-open', { bookId: 'b' });
    // nor is a listener added afterwards kept
    neo.on('book-open', () => heard++);
    NeoPlugins.emit('book-open', { bookId: 'b' });
    assert.equal(heard, 0);
  });

  test('on refuses an event it does not know and a listener that is not a function, and its unsubscribe works', () => {
    const { NeoPlugins, neo } = withPlugin();
    assert.throws(() => neo.on('book-opened', () => {}), { name: 'TypeError', message: /book-opened/ });
    assert.throws(() => neo.on('book-open', 'not a function'), { name: 'TypeError' });
    const heard = [];
    const off = neo.on('book-open', (detail) => heard.push(detail.bookId));
    NeoPlugins.emit('book-open', { bookId: 'one' });
    off();
    NeoPlugins.emit('book-open', { bookId: 'two' });
    assert.deepEqual(heard, ['one']);
  });
});
