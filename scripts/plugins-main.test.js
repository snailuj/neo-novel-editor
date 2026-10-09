'use strict';

// plugins-main.js finds plugin folders (each with a plugin.json), lists
// their commands in a Plugins menu and starts each one's main half. It takes
// Electron's app and ipcMain, and main.js's settings and library folder, from
// wire(), so these tests hand it stand-ins and, where a case needs folders of
// its own, a temporary app folder. Some tests load main.js the way
// filesystem.test.js does, to see the menu, the window's list, the main
// halves and their after-write events wired up.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { after, afterEach, before, describe, test } = require('node:test');

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

// wires the module to stand-ins; dirs becomes NEO_PLUGIN_DIRS. Electron's
// folders sit in the app folder, settings.json is saved.settings, and the
// library folder is whatever library() says
function wire({
  appRoot = root, isPackaged = false, dirs,
  app = { isPackaged, getPath: (name) => path.join(appRoot, name) },
  settings = {}, library = () => path.join(appRoot, 'NEO Library')
} = {}) {
  if (dirs === undefined) delete process.env.NEO_PLUGIN_DIRS;
  else process.env.NEO_PLUGIN_DIRS = dirs;
  const logs = [];
  const handlers = new Map();
  const saved = { settings };
  plugins.wire({
    app,
    ipcMain: { on: (channel, fn) => handlers.set(channel, fn), handle: (channel, fn) => handlers.set(channel, fn) },
    logError: (source, err) => logs.push(`[${source}] ${err && err.stack ? err.stack : String(err)}`),
    appRoot,
    readSettings: () => structuredClone(saved.settings),
    writeSettings: (obj) => { saved.settings = structuredClone(obj); },
    libraryDir: library
  });
  return { logs, handlers, saved };
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
    assert.equal(probe.mainPath, path.join(root, fixtures, 'probe', 'main.js'));
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

describe('a plugin\'s main half', { concurrency: 1 }, () => {
  // a temporary app folder with a plugin for each id, whose main.cjs holds
  // the source given
  function withMains(sources) {
    const app = appFolder(Object.fromEntries(Object.keys(sources)
      .map((id) => [`plugins/${id}`, plugin(id, { main: 'main.cjs' })])));
    for (const [id, source] of Object.entries(sources)) fs.writeFileSync(path.join(app, 'plugins', id, 'main.cjs'), source);
    return app;
  }
  const mainOf = (app, id) => require(path.join(app, 'plugins', id, 'main.cjs'));
  // a main half that keeps the host it is handed, for the test to use
  const keeper = 'exports.activate = (host) => { exports.host = host; };';
  const invoke = (handlers, ...args) => handlers.get('plugin:invoke')({}, ...args);
  // a promise's handlers have run, and so has anything set on setImmediate
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  test('invoke reaches the probe\'s main half and resolves its answer', async () => {
    const { handlers } = wire({ dirs: fixtures });
    plugins.activateMains();
    assert.deepEqual(await invoke(handlers, 'probe', 'echo', { a: 1 }), { a: 1 });
  });

  test('an invoke sent before a slow activate ends waits for it, then resolves', async () => {
    const app = withMains({
      slow: [
        'let open;',
        'exports.opened = new Promise((resolve) => { open = resolve; });',
        'exports.open = () => open();',
        "exports.activate = async (host) => { await exports.opened; host.handle('echo', (payload) => payload); };"
      ].join('\n')
    });
    const { handlers } = wire({ appRoot: app });
    plugins.activateMains(); // returns while slow's activate still waits
    let answered = false;
    const answer = invoke(handlers, 'slow', 'echo', { a: 1 }).finally(() => { answered = true; });
    await turn();
    assert.equal(answered, false, 'no answer while activate is still running');
    mainOf(app, 'slow').open();
    assert.deepEqual(await answer, { a: 1 });
  });

  test('a plugin with no main half, a channel its half never took, or a name that is no channel rejects naming the channel', async () => {
    const { handlers } = wire({ dirs: fixtures });
    plugins.activateMains();
    await assert.rejects(invoke(handlers, 'other', 'echo'), /\becho\b/);
    await assert.rejects(invoke(handlers, 'broken', 'echo'), /\becho\b/); // a window half alone
    await assert.rejects(invoke(handlers, 'probe', 'nope'), /\bnope\b/);
    await assert.rejects(invoke(handlers, 'probe', 'Echo Me'), { name: 'TypeError', message: /Echo Me/ });
  });

  test('a handler that throws rejects the invoke, and the error is logged with its stack', async () => {
    const { handlers, logs } = wire({ dirs: fixtures });
    plugins.activateMains();
    await assert.rejects(invoke(handlers, 'probe', 'fail'), /failed on purpose/);
    assert.equal(logs.length, 1, logs.join('\n'));
    assert.match(logs[0], /^\[plugin probe: invoke fail\] Error: failed on purpose\n\s+at /);
  });

  test('a main half that throws in activate, rejects, will not load or has no activate is logged, and the next still loads', async () => {
    const app = withMains({
      'a-throws': "exports.activate = (host) => { host.handle('echo', (p) => p); throw new Error('thrown in activate'); };",
      'b-rejects': "exports.activate = async (host) => { host.handle('echo', (p) => p); throw new Error('rejected in activate'); };",
      'c-unloadable': 'this is not JavaScript',
      'd-inert': 'exports.answer = 42;',
      'e-good': "exports.activate = (host) => host.handle('echo', (p) => p);"
    });
    const { handlers, logs } = wire({ appRoot: app });
    plugins.activateMains();
    assert.equal(await invoke(handlers, 'e-good', 'echo', 7), 7);
    // a half that failed answers nothing, not even what it took before it failed
    for (const id of ['a-throws', 'b-rejects', 'c-unloadable', 'd-inert']) {
      await assert.rejects(invoke(handlers, id, 'echo'), new RegExp(`${id}\\b.*\\becho\\b`), id);
    }
    const line = (id) => logs.find((l) => l.startsWith(`[plugin ${id}: activate]`)) || `nothing logged for ${id}`;
    assert.match(line('a-throws'), /\] Error: thrown in activate\n\s+at /);
    assert.match(line('b-rejects'), /\] Error: rejected in activate\n\s+at /);
    assert.match(line('c-unloadable'), /SyntaxError: /);
    assert.match(line('d-inert'), /TypeError: .*no activate function/);
    assert.equal(logs.length, 4, logs.join('\n'));
  });

  test('activateMains starts each main half once, however often it runs', async () => {
    const app = withMains({ once: "let n = 0; exports.activate = (host) => { n++; host.handle('count', () => n); };" });
    const { handlers } = wire({ appRoot: app });
    plugins.activateMains();
    plugins.activateMains();
    assert.equal(await invoke(handlers, 'once', 'count'), 1);
  });

  test('handle refuses a name that is no channel, a handler that is not a function, and a channel already taken', async () => {
    const app = withMains({ keeper });
    const { handlers } = wire({ appRoot: app });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    host.handle('index.rebuild-2', () => 'first');
    host.handle('x'.repeat(64), () => 'longest');
    for (const bad of ['Index', '2nd', '-x', '', 'x'.repeat(65), 'a/b', 'a b', 7, null]) {
      assert.throws(() => host.handle(bad, () => 'no'), TypeError, String(bad));
    }
    assert.throws(() => host.handle('later', 'not a function'), TypeError);
    assert.throws(() => host.handle('index.rebuild-2', () => 'second'), TypeError);
    assert.equal(await invoke(handlers, 'keeper', 'index.rebuild-2'), 'first');
    assert.equal(await invoke(handlers, 'keeper', 'x'.repeat(64)), 'longest');
  });

  test('paths name the library folder as it is now, NEO\'s userData folder and the plugin\'s own folder', () => {
    const app = withMains({ keeper });
    let library = path.join(app, 'first library');
    wire({ appRoot: app, library: () => library });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    assert.equal(host.id, 'keeper');
    assert.equal(host.paths.library(), path.join(app, 'first library'));
    library = path.join(app, 'second library'); // File > Library Folder moves it
    assert.equal(host.paths.library(), path.join(app, 'second library'));
    assert.equal(host.paths.userData, path.join(app, 'userData'));
    assert.equal(host.paths.plugin, path.join(app, 'plugins', 'keeper'));
  });

  test('settings are the plugin\'s own: get reads them, set replaces them and refuses what is not an object', () => {
    const app = withMains({ keeper });
    const { saved } = wire({ appRoot: app, settings: { libraryDir: 'D:\\Books', plugins: { other: { kept: true } } } });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    assert.deepEqual(host.settings.get(), {});
    host.settings.set({ colour: 'green' });
    assert.deepEqual(host.settings.get(), { colour: 'green' });
    assert.deepEqual(saved.settings, { libraryDir: 'D:\\Books', plugins: { other: { kept: true }, keeper: { colour: 'green' } } });
    for (const bad of [null, [], 'green', 7]) assert.throws(() => host.settings.set(bad), TypeError, String(bad));
    assert.deepEqual(host.settings.get(), { colour: 'green' });
  });

  test('settings.set writes nothing over a settings.json that holds no object', () => {
    const app = withMains({ keeper });
    const { saved } = wire({ appRoot: app });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    for (const settings of [[], null, 'text', 7]) {
      saved.settings = settings;
      assert.throws(() => host.settings.set({ colour: 'green' }), Error, String(settings));
      assert.equal(saved.settings, settings, `${settings} is left as it is`);
    }
  });

  test('log writes errors and warnings to the error log under the plugin\'s name, the rest to the console, and refuses a level it does not know', (t) => {
    const app = withMains({ keeper });
    const { logs } = wire({ appRoot: app });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    const printed = [];
    t.mock.method(console, 'log', (line) => printed.push(line));
    host.log('error', 'the index is unreadable', new Error('index cut short'));
    host.log('warn', 'slow rebuild', { ms: 1200 });
    host.log('info', 'indexed', { chapters: 3 });
    host.log('debug', 'looked');
    assert.throws(() => host.log('loud', 'shouted'), TypeError);
    assert.equal(logs.length, 2, logs.join('\n'));
    assert.match(logs[0], /^\[plugin keeper: error\] the index is unreadable Error: index cut short\n\s+at /);
    assert.equal(logs[1], '[plugin keeper: warn] slow rebuild {"ms":1200}');
    assert.deepEqual(printed, ['[plugin keeper: info] indexed {"chapters":3}', '[plugin keeper: debug] looked']);
  });

  test('after-write listeners hear each write on a later turn; one that throws or rejects is logged and the rest still hear it', async () => {
    const app = withMains({ keeper, other: keeper });
    const { logs } = wire({ appRoot: app });
    plugins.activateMains();
    const first = mainOf(app, 'keeper').host;
    const second = mainOf(app, 'other').host;
    const heard = [];
    first.onAfterWrite(() => { throw new Error('throws on purpose'); });
    first.onAfterWrite(async () => { throw new Error('rejects on purpose'); });
    const off = second.onAfterWrite((event) => heard.push(event));
    plugins.afterWrite('chapter', 'book-a', 'c1');
    assert.deepEqual(heard, [], 'nothing is heard while the write is answered');
    await turn();
    assert.deepEqual(heard, [{ kind: 'chapter', bookId: 'book-a', name: 'c1' }]);
    assert.ok(Object.isFrozen(heard[0]), 'every listener is handed the same detail, so it is frozen');
    assert.equal(logs.length, 2, logs.join('\n'));
    assert.match(logs[0], /^\[plugin keeper: after-write\] Error: throws on purpose\n\s+at /);
    assert.match(logs[1], /^\[plugin keeper: after-write\] Error: rejects on purpose\n\s+at /);
    off();
    plugins.afterWrite('aux', 'book-a', 'notes');
    await turn();
    assert.equal(heard.length, 1, 'an unsubscribed listener hears nothing');
    assert.throws(() => first.onAfterWrite('not a function'), TypeError);
  });

  // neo-errors.log sits in the synced library, and each line is written on
  // the main thread; a chapter is saved every few seconds while the writer
  // types
  test('an after-write listener that fails every time is logged once, then at most once a minute with a count', async (t) => {
    const clock = { now: 0 };
    t.mock.method(performance, 'now', () => clock.now);
    const app = withMains({ keeper });
    const { logs } = wire({ appRoot: app });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    host.onAfterWrite(() => { throw new Error('throws every time'); });
    host.onAfterWrite(async () => { throw new Error('rejects every time'); });
    const writes = async (n) => {
      for (let i = 0; i < n; i++) plugins.afterWrite('chapter', 'b', 'c');
      await turn();
    };
    await writes(100);
    assert.equal(logs.length, 2, 'the first failure of each listener');
    assert.match(logs[0], /^\[plugin keeper: after-write\] Error: throws every time\n\s+at /);
    assert.match(logs[1], /^\[plugin keeper: after-write\] Error: rejects every time\n\s+at /);
    clock.now += 59999;
    await writes(10);
    assert.equal(logs.length, 2);
    clock.now += 1;
    await writes(1);
    assert.equal(logs.length, 4);
    assert.match(logs[2], /^\[plugin keeper: after-write\] 109 more failures of this listener since its last line; the latest: Error: throws every time\n\s+at /);
    assert.match(logs[3], /^\[plugin keeper: after-write\] 109 more failures of this listener since its last line; the latest: Error: rejects every time\n\s+at /);
    // a minute with none, and the next is logged as a first
    clock.now += 60000;
    await writes(1);
    assert.equal(logs.length, 6);
    assert.match(logs[4], /^\[plugin keeper: after-write\] Error: throws every time\n/);
  });
});

describe('main.js and the plugins\' main halves', { concurrency: 1 }, () => {
  // main.js in a vm, as filesystem.test.js loads it, on a temporary profile
  // whose settings.json already holds other settings. ready() runs what
  // main.js does once Electron is ready, with the window, the menu, the
  // spellchecker, the backup and the updater stood in for.
  const probeMain = path.join(root, fixtures, 'probe', 'main.js');
  let profile = null;
  let main = null;
  const library = () => path.join(profile, 'documents', 'NEO Library');
  const errorLog = () => {
    try { return fs.readFileSync(path.join(library(), 'neo-errors.log'), 'utf8'); } catch { return ''; }
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  function loadMain() {
    const handlers = new Map();
    let whenReady = null;
    const electron = {
      app: {
        isPackaged: false,
        commandLine: { appendSwitch() {} },
        getPath: (name) => path.join(profile, name),
        getLocale: () => 'en',
        requestSingleInstanceLock: () => true,
        whenReady: () => ({ then: (fn) => { whenReady = fn; } }),
        on() {}
      },
      ipcMain: { on() {}, handle: (channel, fn) => handlers.set(channel, fn) },
      BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
      Menu: { buildFromTemplate: (items) => items, setApplicationMenu() {} },
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
      setInterval: () => ({}),
      libraryRoot: library()
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: path.join(root, 'main.js') });
    // nothing is logged into the real Documents folder before ready() moves the library
    vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);
    return {
      call: (channel, ...args) => handlers.get(channel)(null, ...args),
      ready(order) {
        context.createWindow = () => order.push('createWindow');
        for (const name of ['announceLibraryFallback', 'initSpell', 'buildMenu', 'checkForUpdates']) context[name] = () => {};
        context.dailyBackup = async () => {};
        whenReady();
      }
    };
  }

  before(() => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-plugins-main-'));
    fs.mkdirSync(path.join(profile, 'userData'));
    fs.writeFileSync(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ pageTheme: 'light', plugins: { other: { kept: true } } }));
    // read once, by the first test's ready()
    process.env.NEO_PLUGIN_DIRS = fixtures;
    main = loadMain();
  });
  after(() => fs.rmSync(profile, { recursive: true, force: true }));

  test('the window is created before any main half activates, and plugin:invoke answers from main.js', async (t) => {
    const order = [];
    const probe = require(probeMain);
    const activate = probe.activate;
    t.mock.method(probe, 'activate', (host) => { order.push('activate probe'); return activate(host); });
    main.ready(order);
    assert.deepEqual(order, ['createWindow', 'activate probe']);
    assert.deepEqual(await main.call('plugin:invoke', 'probe', 'echo', { a: 1 }), { a: 1 });
    assert.doesNotMatch(errorLog(), /\[(startup|plugins)\]/);
  });

  test('paths name the profile\'s library and userData folders and the probe\'s own folder', () => {
    const { host } = require(probeMain);
    assert.equal(host.paths.library(), library());
    assert.equal(host.paths.userData, path.join(profile, 'userData'));
    assert.equal(host.paths.plugin, path.join(root, fixtures, 'probe'));
  });

  test('settings.set keeps the other keys of settings.json, other plugins\' among them', () => {
    const { host } = require(probeMain);
    assert.deepEqual(host.settings.get(), {});
    host.settings.set({ colour: 'green' });
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'userData', 'settings.json'), 'utf8'));
    assert.equal(saved.pageTheme, 'light');
    assert.deepEqual(saved.plugins, { other: { kept: true }, probe: { colour: 'green' } });
    // read by main.js, in the vm's realm, so compared as JSON
    assert.equal(JSON.stringify(host.settings.get()), '{"colour":"green"}');
  });

  // a sync client or an antivirus scan can leave settings.json half there
  // for a moment; written back whole, it would forget the library folder
  test('settings.json that will not parse is never written over, and one not there yet is started afresh', () => {
    const { host } = require(probeMain);
    const file = path.join(profile, 'userData', 'settings.json');
    const whole = fs.readFileSync(file, 'utf8');
    try {
      const cut = whole.slice(0, -5);
      fs.writeFileSync(file, cut);
      // thrown in the vm's realm, so matched by name
      assert.throws(() => host.settings.set({ colour: 'blue' }), { name: 'SyntaxError' });
      assert.throws(() => host.settings.get(), { name: 'SyntaxError' });
      assert.equal(fs.readFileSync(file, 'utf8'), cut, 'settings.json is left as it was');
      fs.rmSync(file);
      host.settings.set({ colour: 'blue' });
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ plugins: { probe: { colour: 'blue' } } }, null, 2));
    } finally {
      fs.writeFileSync(file, whole);
    }
  });

  test('chapter:write answers before after-write listeners hear of it, and one that throws fails nothing', async () => {
    const { host } = require(probeMain);
    const heard = [];
    const offs = [
      host.onAfterWrite(() => { throw new Error('an after-write listener throws on purpose'); }),
      host.onAfterWrite((event) => heard.push(event))
    ];
    try {
      const book = main.call('book:create', { title: 'Owls', author: 'Ada' });
      assert.equal(main.call('chapter:write', book.id, 'c1', '<p>Owl</p>'), true);
      assert.deepEqual(heard, [], 'the write answered before any listener ran');
      await turn();
      assert.deepEqual(heard, [{ kind: 'chapter', bookId: book.id, name: 'c1' }]);
      assert.equal(main.call('chapter:read', book.id, 'c1'), '<p>Owl</p>');
      assert.match(errorLog(), /\[plugin probe: after-write\] Error: an after-write listener throws on purpose\r?\n\s+at /);
    } finally {
      for (const off of offs) off();
    }
  });

  test('aux, JSON and book.json writes are heard with their kind, book and name; a chapter write refused for a conflict is not', async () => {
    const { host } = require(probeMain);
    const heard = [];
    const off = host.onAfterWrite((event) => heard.push(event));
    try {
      const book = main.call('book:create', { title: 'Foxes', author: 'Ada' });
      main.call('aux:write', book.id, 'notes', '<p>margin</p>');
      main.call('json:write', book.id, 'darlings', []);
      main.call('book:writeMeta', book.id, { ...book });
      main.call('chapter:write', book.id, 'c1', '<p>Fox</p>');
      await turn();
      assert.deepEqual(heard, [
        { kind: 'aux', bookId: book.id, name: 'notes' },
        { kind: 'json', bookId: book.id, name: 'darlings' },
        { kind: 'meta', bookId: book.id, name: 'book' },
        { kind: 'chapter', bookId: book.id, name: 'c1' }
      ]);
      // another device wrote other words since: nothing is written, so nothing is heard
      const refused = main.call('chapter:write', book.id, 'c1', '<p>Badger</p>', '<p>An older text</p>');
      assert.equal(JSON.stringify(refused), '{"conflict":"<p>Fox</p>"}');
      await turn();
      assert.equal(heard.length, 4);
    } finally {
      off();
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
  // the page: what it would add to the page (an element's remove() takes it
  // off again), what it logs, and what it writes to the console. reads
  // stands in for app.js's getters; logError, when given, for the log;
  // clock.now is what performance.now() reads; invoked holds what reached
  // window.neo.pluginInvoke.
  function windowHalf(list, reads = {}, logError = null) {
    const added = [];
    const logged = [];
    const consoled = [];
    const invoked = [];
    const clock = { now: 0 };
    const page = { appendChild: (el) => added.push(el) };
    const element = (tag) => ({
      tag,
      remove() {
        const i = added.indexOf(this);
        if (i >= 0) added.splice(i, 1);
      }
    });
    const context = vm.createContext({
      neo: {
        plugins: list,
        logError: logError || ((line) => logged.push(line)),
        pluginInvoke: async (...args) => { invoked.push(args); return { answered: args[2] }; }
      },
      document: { head: page, body: page, addEventListener() {}, createElement: element },
      requestAnimationFrame: () => 1,
      performance: { now: () => clock.now },
      console: { error: (...args) => consoled.push(args.map(String).join(' ')) },
      structuredClone
    });
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(root, 'plugins.js'), 'utf8'), context, { filename: 'plugins.js' });
    const getters = { book: () => null, chapterHTML: () => undefined, currentTab: () => 'manuscript', ...reads };
    return { NeoPlugins: context.NeoPlugins, attach: () => context.NeoPlugins.attach(getters), added, logged, consoled, invoked, clock };
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

  test('invoke reaches the calling plugin\'s own main half, and a plugin that failed to activate invokes nothing', async () => {
    const { neo, invoked } = withPlugin();
    assert.deepEqual(await neo.invoke('echo', { a: 1 }), { answered: { a: 1 } });
    assert.deepEqual(invoked, [['p', 'echo', { a: 1 }]], 'the id is the caller\'s own');
    const failed = withPlugin(() => { throw new Error('activate fails on purpose'); });
    await assert.rejects(failed.neo.invoke('echo', { a: 2 }), /\bp\b.*\becho\b/);
    assert.deepEqual(failed.invoked, []);
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

  test('the attach hook hands over app.js\'s own book, and its comment points to the rule in plugins.js', () => {
    const lines = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split(/\r?\n/);
    const at = lines.findIndex((line) => /\bNeoPlugins\.attach\(/.test(line));
    assert.match(lines[at], /\bbook: \(\) => book\b/);
    const comment = [];
    for (let i = at - 1; /^\s*\/\//.test(lines[i]); i--) comment.unshift(lines[i]);
    assert.match(comment.join(' '), /\bopenedBook\b/, comment.join('\n'));
    assert.match(fs.readFileSync(path.join(root, 'plugins.js'), 'utf8'), /\bfunction openedBook\(/);
  });

  const listedP = { id: 'p', apiVersion: 1, rendererUrl: 'plugins/p/renderer.js', styleUrl: null };

  test('an activate that subscribes after an await still hears the open book, once it has settled', async () => {
    const book = { id: 'owls', chapterOrder: [] };
    const host = windowHalf([listedP], { book: () => book });
    host.attach();
    host.NeoPlugins.emit('book-open', { bookId: 'owls' });
    const heard = [];
    host.NeoPlugins.register({ id: 'p', apiVersion: 1, async activate(neo) {
      await null;
      neo.on('book-open', (detail) => heard.push(detail.bookId));
    } });
    await settled();
    assert.deepEqual(heard, ['owls']);
  });

  test('an opening a plugin heard while its activate waited is not told again when it settles', async () => {
    let book = null;
    const host = windowHalf([listedP], { book: () => book });
    host.attach();
    const heard = [];
    let release;
    host.NeoPlugins.register({ id: 'p', apiVersion: 1, async activate(neo) {
      neo.on('book-open', (detail) => heard.push(detail.bookId));
      await new Promise((resolve) => { release = resolve; });
    } });
    book = { id: 'owls', chapterOrder: [] };
    host.NeoPlugins.emit('book-open', { bookId: 'owls' });
    release();
    await settled();
    assert.deepEqual(heard, ['owls']);
  });

  test('an activate that rejects after subscribing is never told of the open book', async () => {
    const book = { id: 'owls', chapterOrder: [] };
    const host = windowHalf([listedP], { book: () => book });
    host.attach();
    host.NeoPlugins.emit('book-open', { bookId: 'owls' });
    const heard = [];
    host.NeoPlugins.register({ id: 'p', apiVersion: 1, async activate(neo) {
      neo.on('book-open', (detail) => heard.push(detail.bookId));
      await null;
      throw new Error('activate rejected on purpose');
    } });
    await settled();
    assert.deepEqual(heard, []);
    assert.match(host.logged[0], /^plugin p: Error: activate rejected on purpose\n\s+at /);
  });

  test('a refused, failed or unloaded plugin\'s stylesheet leaves the page; a stray second register keeps a working one\'s', async () => {
    const styled = (id) => ({ id, apiVersion: 1, rendererUrl: `plugins/${id}/renderer.js`, styleUrl: `plugins/${id}/style.css` });
    const host = windowHalf(['works', 'refused', 'throws', 'rejects', 'unloaded'].map(styled));
    host.attach();
    const links = () => host.added.filter((el) => el.tag === 'link').map((el) => el.href);
    assert.equal(links().length, 5);
    const { register } = host.NeoPlugins;
    register({ id: 'works', apiVersion: 1, activate() {} });
    register({ id: 'refused', apiVersion: 2, activate() {} });
    register({ id: 'throws', apiVersion: 1, activate() { throw new Error('throws on purpose'); } });
    register({ id: 'rejects', apiVersion: 1, async activate() { throw new Error('rejects on purpose'); } });
    host.added.find((el) => el.src === 'plugins/unloaded/renderer.js').onerror();
    register({ id: 'works', apiVersion: 99, activate() {} });
    await settled();
    assert.deepEqual(links(), ['plugins/works/style.css']);
  });

  test('attach skips a null or id-less entry in the list, as register does', () => {
    const host = windowHalf([null, { apiVersion: 1, rendererUrl: 'plugins/x/renderer.js', styleUrl: 'plugins/x/style.css' }, listedP]);
    host.attach();
    assert.deepEqual(host.added.map((el) => el.src || el.href), ['plugins/p/renderer.js']);
    let activated = false;
    host.NeoPlugins.register({ apiVersion: 1, activate() { activated = true; } });
    assert.equal(activated, false, 'a plugin with no id never matches an entry with none');
  });

  test('a log that throws or rejects never escapes into NEO: the line goes to the console instead', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const logError of [() => { throw new Error('log down'); }, () => Promise.reject(new Error('log down'))]) {
        const host = windowHalf([listedP], {}, logError);
        host.attach();
        let neo = null;
        host.NeoPlugins.register({ id: 'p', apiVersion: 1, activate(api) { neo = api; } });
        neo.on('chapter-saved', () => { throw new Error('a listener throws on purpose'); });
        neo.on('chapter-saved', async () => { throw new Error('a listener rejects on purpose'); });
        assert.doesNotThrow(() => host.NeoPlugins.emit('chapter-saved', { bookId: 'b', chId: 'c' }));
        await settled();
        await settled();
        assert.equal(host.consoled.length, 2, host.consoled.join('\n'));
        assert.match(host.consoled[0], /^plugin p: Error: a listener throws on purpose\n[\s\S]*Error: log down/);
        assert.match(host.consoled[1], /^plugin p: Error: a listener rejects on purpose\n[\s\S]*Error: log down/);
      }
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  test('nothing done to a book a shelf export borrowed reaches the plugins; a save landing after its book closed does', () => {
    // app.js's book, borrowed by a shelf export: no plugin heard it open
    let book = { id: 'other', chapterOrder: ['c0'] };
    const heard = [];
    const { NeoPlugins } = withPlugin((api) => {
      for (const name of ['rendered', 'chapter-saved', 'book-close']) api.on(name, (detail) => heard.push([name, detail.bookId]));
    }, { book: () => book });
    NeoPlugins.emit('rendered', { bookId: 'other' });
    NeoPlugins.emit('chapter-saved', { bookId: 'other', chId: 'c0' });
    NeoPlugins.emit('book-close', { bookId: 'other' });
    assert.deepEqual(heard, [], 'the borrowed book');
    book = { id: 'owls', chapterOrder: ['c1'] };
    NeoPlugins.emit('book-open', { bookId: 'owls' });
    NeoPlugins.emit('rendered', { bookId: 'owls' });
    NeoPlugins.emit('chapter-saved', { bookId: 'owls', chId: 'c1' });
    NeoPlugins.emit('book-close', { bookId: 'owls' });
    book = null;
    // the flush on the way to the shelf lands after the book has closed
    NeoPlugins.emit('chapter-saved', { bookId: 'owls', chId: 'c1' });
    assert.deepEqual(heard, [
      ['rendered', 'owls'],
      ['chapter-saved', 'owls'],
      ['book-close', 'owls'],
      ['chapter-saved', 'owls']
    ]);
  });
});
