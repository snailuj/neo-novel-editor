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

// The checkout's own plugins/ holds whatever has been built or installed
// there (it is git-ignored). A test that discovers it activates that, and
// then passes or fails on what happens to be in it. Every read of that
// folder is noted, and the file fails if there was one: tests use a
// temporary app folder.
const ownPlugins = path.join(root, 'plugins');
const ownReads = [];
const readdirSync = fs.readdirSync;
fs.readdirSync = function (dir, ...rest) {
  const rel = path.relative(ownPlugins, path.resolve(String(dir)));
  if (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) ownReads.push(String(dir));
  return readdirSync.call(this, dir, ...rest);
};
after(() => {
  fs.readdirSync = readdirSync;
  assert.deepEqual(ownReads, [], 'a test discovered the worktree\'s own plugins/ folder');
});

// wires the module to stand-ins; dirs becomes NEO_PLUGIN_DIRS. Electron's
// folders sit in the app folder (by default a temporary one that holds the
// fixture plugins), settings.json is saved.settings, and the library folder
// is whatever library() says
function wire({
  appRoot = fixtureApp(), isPackaged = false, dirs,
  app = { isPackaged, getPath: (name) => path.join(appRoot, name) },
  settings = {}, library = () => path.join(appRoot, 'NEO Library'), activateMs,
  // plugins-main.js starts each main half a turn after activateMains; the
  // tests start theirs at once unless a test passes null for its own way
  defer = (run) => run()
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
    libraryDir: library,
    defer,
    ...(activateMs === undefined ? {} : { activateMs })
  });
  return { logs, handlers, saved, appRoot };
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

// an app folder (a new temporary one, unless given) holding a copy of the
// fixture plugins, where the worktree's own plugins/ cannot be found;
// locales/ is there, empty, for main.js, which reads it from its own folder
function fixtureApp(dir = tempFolder()) {
  fs.cpSync(path.join(root, fixtures), path.join(dir, fixtures), { recursive: true });
  fs.mkdirSync(path.join(dir, 'locales'));
  return dir;
}

// preload.js in a vm, with ipcRenderer.invoke answered by call(channel,
// ...args): window.neo as the page gets it. A main half's answer crosses
// IPC here as it does in Electron, so a test sees what a plugin would.
function windowNeo(call) {
  let neo = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { neo = api; } },
    ipcRenderer: { sendSync: () => [], invoke: async (...args) => call(...args), send() {}, on() {} },
    webUtils: {}
  };
  const context = vm.createContext({ require: () => electron, process: { platform: process.platform } });
  vm.runInContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), context, { filename: 'preload.js' });
  return neo;
}

const plugin = (id, extra) => ({ id, apiVersion: 1, renderer: 'renderer.js', ...extra });
const ids = () => plugins.discover().map((m) => m.id);
const find = (id) => plugins.discover().find((m) => m.id === id);

describe('plugin discovery', { concurrency: 1 }, () => {
  test('the probe is listed with its renderer URL relative to the app folder, on every platform', () => {
    const { appRoot } = wire({ dirs: fixtures });
    const probe = find('probe');
    assert.ok(probe, 'probe is listed');
    assert.equal(probe.rendererUrl, 'scripts/fixtures/plugins/probe/renderer.js');
    assert.equal(probe.styleUrl, 'scripts/fixtures/plugins/probe/style.css');
    assert.equal(probe.mainPath, path.join(appRoot, fixtures, 'probe', 'main.js'));
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

  // a newer API may well add to the manifest too, so the rest of such a
  // manifest is not judged
  test('a manifest for a newer plugin API than this NEO knows is refused with a reason that names both versions', () => {
    const app = appFolder({
      'plugins/ahead': plugin('ahead', { apiVersion: 3 }),
      'plugins/far-ahead': plugin('far-ahead', { apiVersion: 12, newKey: true }),
      'plugins/zero': plugin('zero', { apiVersion: 0 }),
      'plugins/fraction': plugin('fraction', { apiVersion: 2.5 }),
      'plugins/text': plugin('text', { apiVersion: '3' }),
      'plugins/current': plugin('current', { apiVersion: 2 })
    });
    const { logs } = wire({ appRoot: app });
    assert.deepEqual(ids(), ['current']);
    assert.equal(logs.length, 5, logs.join('\n'));
    const line = (name) => logs.find((l) => l.includes(path.join(app, 'plugins', name))) || `nothing logged for ${name}`;
    assert.match(line('ahead'), /needs plugin API 3\b.*\bthis NEO knows up to 2\b/);
    assert.match(line('far-ahead'), /needs plugin API 12\b.*\bthis NEO knows up to 2\b/);
    for (const name of ['zero', 'fraction', 'text']) assert.match(line(name), /does not match the manifest format/, name);
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
    const app = fixtureApp();
    const shouted = app.toUpperCase() === app ? app.toLowerCase() : app.toUpperCase();
    wire({ appRoot: app, dirs: path.join(shouted, fixtures) });
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

  // readdir, readFile and require all follow a link, wherever in a path it
  // sits, so what is checked is where each path really leads
  describe('a link further up or down than a plugin folder', () => {
    const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
    function link(t, target, at, type = dirLink) {
      try {
        fs.symlinkSync(target, at, type);
        return true;
      } catch (err) {
        t.skip(`this system refused the link: ${err.code}`);
        return false;
      }
    }
    const real = (p) => fs.realpathSync.native(p);

    test('a plugin root that is a link leading outside the app folder is refused and logged', (t) => {
      const app = appFolder({});
      const elsewhere = tempFolder();
      addPlugin(elsewhere, 'out', plugin('out'));
      if (!link(t, elsewhere, path.join(app, 'dev'))) return;
      const { logs } = wire({ appRoot: app, dirs: 'dev' });
      assert.deepEqual(ids(), []);
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /outside the app folder/);
      assert.ok(logs[0].includes(path.join(app, 'dev')), 'the root is named');
      assert.ok(logs[0].includes(real(elsewhere)), 'and where it leads');
    });

    test('plugins/ itself a link leading outside the app folder is refused and logged', (t) => {
      const app = appFolder({});
      const elsewhere = tempFolder();
      addPlugin(elsewhere, 'out', plugin('out'));
      if (!link(t, elsewhere, path.join(app, 'plugins'))) return;
      const { logs } = wire({ appRoot: app });
      assert.deepEqual(ids(), []);
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /outside the app folder/);
      assert.ok(logs[0].includes(path.join(app, 'plugins')));
    });

    // the page loads a plugin's script and stylesheet by URL, and Chromium's
    // answer to a link in the way differs by platform, so the rule is NEO's
    test('a renderer or a style that is a link leading outside the app folder refuses its plugin, and is logged', (t) => {
      const app = appFolder({
        'plugins/a-script': plugin('script'),
        'plugins/b-sheet': plugin('sheet', { style: 'style.css' }),
        'plugins/c-fine': plugin('fine', { style: 'style.css' })
      });
      const elsewhere = tempFolder();
      fs.writeFileSync(path.join(elsewhere, 'outside.js'), '');
      fs.writeFileSync(path.join(elsewhere, 'outside.css'), '');
      for (const name of ['b-sheet', 'c-fine']) fs.writeFileSync(path.join(app, 'plugins', name, 'renderer.js'), '');
      fs.writeFileSync(path.join(app, 'plugins', 'c-fine', 'style.css'), '');
      if (!link(t, path.join(elsewhere, 'outside.js'), path.join(app, 'plugins', 'a-script', 'renderer.js'), 'file')) return;
      link(t, path.join(elsewhere, 'outside.css'), path.join(app, 'plugins', 'b-sheet', 'style.css'), 'file');
      const { logs } = wire({ appRoot: app });
      assert.deepEqual(ids(), ['fine']);
      assert.equal(logs.length, 2, logs.join('\n'));
      assert.ok(logs[0].includes(path.join(app, 'plugins', 'a-script')));
      assert.match(logs[0], /its renderer leads outside the app folder/);
      assert.ok(logs[1].includes(path.join(app, 'plugins', 'b-sheet')));
      assert.match(logs[1], /its style leads outside the app folder/);
    });

    test('a renderer or a style that is not there leads nowhere: the plugin is listed, and the window logs the script that will not load', () => {
      const app = appFolder({ 'plugins/bare': plugin('bare', { style: 'style.css' }) });
      const { logs } = wire({ appRoot: app });
      assert.deepEqual(ids(), ['bare']);
      assert.deepEqual(logs, []);
    });

    // require follows what it is given: through a link, to a main.js.js beside
    // a missing main.js, into a folder named main.js by its package.json.
    // start() checks the file require will load, and requires that path.
    const ran = 'neoOutsideMainRan';
    afterEach(() => { delete globalThis[ran]; });
    function outsideMain() {
      const file = path.join(tempFolder(), 'outside.cjs');
      fs.writeFileSync(file, `globalThis.${ran} = true; exports.activate = () => {};`);
      return file;
    }

    test('a main entry that is a link leading outside the app folder is never required: its main half fails and is logged, and the next still starts', async (t) => {
      const app = appFolder({ 'plugins/a-sly': plugin('sly', { main: 'main.cjs' }), 'plugins/b-good': plugin('good', { main: 'main.cjs' }) });
      fs.writeFileSync(path.join(app, 'plugins', 'b-good', 'main.cjs'), 'exports.activate = (host) => host.handle("echo", (p) => p);');
      if (!link(t, outsideMain(), path.join(app, 'plugins', 'a-sly', 'main.cjs'), 'file')) return;
      const { logs } = wire({ appRoot: app });
      assert.deepEqual(ids(), ['sly', 'good']);
      plugins.activateMains();
      assert.equal(globalThis[ran], undefined, 'the file outside was not run');
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /^\[plugin sly: activate\] .*main entry.*outside the app folder/);
    });

    test('a main.js.js link to a file outside is not what a missing main.js becomes', (t) => {
      const app = appFolder({ 'plugins/odd': plugin('odd', { main: 'main.js' }) });
      if (!link(t, outsideMain(), path.join(app, 'plugins', 'odd', 'main.js.js'), 'file')) return;
      const { logs } = wire({ appRoot: app });
      plugins.activateMains();
      assert.equal(globalThis[ran], undefined, 'the file outside was not run');
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /^\[plugin odd: activate\] .*ENOENT/);
    });

    test('a main entry that is a folder is never required, whatever its package.json names', () => {
      const app = appFolder({ 'plugins/pkg': plugin('pkg', { main: 'main.js' }) });
      const folder = path.join(app, 'plugins', 'pkg', 'main.js');
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ main: outsideMain() }));
      const { logs } = wire({ appRoot: app });
      plugins.activateMains();
      assert.equal(globalThis[ran], undefined, 'the file outside was not run');
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /^\[plugin pkg: activate\] .*main entry is not a file/);
    });

    test('a main entry that is not there leads nowhere: its plugin is listed, and activate logs the absence', () => {
      const app = appFolder({ 'plugins/hollow': plugin('hollow', { main: 'main.cjs' }) });
      const { logs } = wire({ appRoot: app });
      assert.deepEqual(ids(), ['hollow']);
      assert.deepEqual(logs, []);
      plugins.activateMains();
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /^\[plugin hollow: activate\] /);
    });

    test('a main entry that is a link to nothing is not followed: activate logs it, and no file outside is required', (t) => {
      const app = appFolder({ 'plugins/dangling': plugin('dangling', { main: 'main.cjs' }) });
      if (!link(t, path.join(tempFolder(), 'gone.cjs'), path.join(app, 'plugins', 'dangling', 'main.cjs'), 'file')) return;
      const { logs } = wire({ appRoot: app });
      assert.deepEqual(ids(), ['dangling']);
      plugins.activateMains();
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /^\[plugin dangling: activate\] /);
    });

    test('a plugin folder that resolves outside the app folder, by whatever means, is refused and logged', (t) => {
      const app = appFolder({ 'plugins/odd': plugin('odd'), 'plugins/fine': plugin('fine') });
      const folder = path.join(app, 'plugins', 'odd');
      const elsewhere = tempFolder();
      const { native } = fs.realpathSync;
      t.mock.method(fs.realpathSync, 'native', (p, ...rest) => p === folder ? elsewhere : native(p, ...rest));
      const { logs } = wire({ appRoot: app });
      assert.deepEqual(ids(), ['fine']);
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /outside the app folder/);
      assert.ok(logs[0].includes(folder));
    });

    test('an app folder reached through a link is no reason to refuse its plugins', (t) => {
      const app = appFolder({ 'plugins/full': plugin('full', { main: 'main.cjs' }) });
      fs.writeFileSync(path.join(app, 'plugins', 'full', 'main.cjs'), 'exports.activate = () => {};');
      const through = path.join(tempFolder(), 'app');
      if (!link(t, app, through)) return;
      const { logs } = wire({ appRoot: through });
      assert.deepEqual(ids(), ['full']);
      assert.deepEqual(logs, []);
    });
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
      __dirname: fixtureApp(),
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
  const invoke = (handlers, ...args) => windowNeo((channel, ...rest) => handlers.get(channel)({}, ...rest)).pluginInvoke(...args);
  // a promise's handlers have run, and so has anything set on setImmediate
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  test('invoke reaches the probe\'s main half and resolves its answer', async () => {
    const { handlers } = wire({ dirs: fixtures });
    plugins.activateMains();
    assert.deepEqual(await invoke(handlers, 'probe', 'echo', { a: 1 }), { a: 1 });
    // an answer that looks like a failure is still an answer
    assert.deepEqual(await invoke(handlers, 'probe', 'echo', { error: 'not a failure' }), { error: 'not a failure' });
    assert.equal(await invoke(handlers, 'probe', 'echo'), undefined);
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
    await assert.rejects(invoke(handlers, 'probe', 'Echo Me'), /Echo Me/);
  });

  // main.js logs and explains every rejection of an ipcMain.handle; a plugin's
  // failure is neither a refused write nor main.js's to log, so it goes back
  // as an answer that the window turns into the rejection
  test('a handler that throws rejects the invoke with an Error naming the plugin and the channel, and is logged once with its stack', async () => {
    const { handlers, logs } = wire({ dirs: fixtures });
    plugins.activateMains();
    await assert.rejects(invoke(handlers, 'probe', 'fail'), (err) => {
      assert.equal(err.constructor.name, 'Error');
      assert.match(err.message, /\bprobe\b.*\bfail\b.*failed on purpose/);
      return true;
    });
    assert.equal(logs.length, 1, logs.join('\n'));
    assert.match(logs[0], /^\[plugin probe: invoke fail\] Error: failed on purpose\n\s+at /);
  });

  test('a handler that rejects or throws what is no Error still rejects the invoke with a message', async () => {
    const app = withMains({
      odd: [
        'exports.activate = (host) => {',
        "  host.handle('text', () => { throw 'plain text'; });",
        "  host.handle('nothing', async () => { throw undefined; });",
        "  host.handle('bare', () => { throw Object.create(null); });",
        '};'
      ].join('\n')
    });
    const { handlers, logs } = wire({ appRoot: app });
    plugins.activateMains();
    await assert.rejects(invoke(handlers, 'odd', 'text'), /\bodd\b.*\btext\b.*plain text/);
    await assert.rejects(invoke(handlers, 'odd', 'nothing'), /\bodd\b.*\bnothing\b/);
    await assert.rejects(invoke(handlers, 'odd', 'bare'), /\bodd\b.*\bbare\b/);
    assert.equal(logs.length, 3, logs.join('\n'));
  });

  // Electron sends an answer by structured clone. One it cannot clone (a
  // function, a Promise inside an object) leaves the window's invoke
  // waiting for ever, and the failure goes to the console, not the log.
  test('a handler whose answer cannot be cloned rejects the invoke and is logged, as any failure of its handler is', async () => {
    const app = withMains({
      odd: [
        'exports.activate = (host) => {',
        "  host.handle('fn', () => () => 1);",
        "  host.handle('promised', async () => ({ later: new Promise(() => {}) }));",
        "  host.handle('plain', () => ({ list: [1, 2], when: new Date(0), none: undefined }));",
        '};'
      ].join('\n')
    });
    const { handlers, logs } = wire({ appRoot: app });
    plugins.activateMains();
    await assert.rejects(invoke(handlers, 'odd', 'fn'), /\bodd\b.*\bfn\b.*could not be cloned/);
    await assert.rejects(invoke(handlers, 'odd', 'promised'), /\bodd\b.*\bpromised\b.*could not be cloned/);
    assert.equal(logs.length, 2, logs.join('\n'));
    assert.match(logs[0], /^\[plugin odd: invoke fn\] /);
    assert.match(logs[1], /^\[plugin odd: invoke promised\] /);
    const plain = await invoke(handlers, 'odd', 'plain');
    assert.deepEqual(plain.list, [1, 2]);
    assert.equal(plain.when.getTime(), 0);
    assert.equal(logs.length, 2);
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

  // an activate that awaits what never comes (a file watcher's ready event,
  // say) would leave its plugin's invokes waiting for ever, and nothing in
  // neo-errors.log to say why
  describe('an activate that does not settle', () => {
    // each main half's activate waits for exports.open(), as a test says
    const gated = (body = '') => [
      'let open;',
      'exports.opened = new Promise((resolve) => { open = resolve; });',
      'exports.open = () => open();',
      `exports.activate = async (host) => { host.handle('echo', (p) => p); await exports.opened; ${body} };`
    ].join('\n');
    // how an invoke stands a turn later: answered, refused or still waiting
    // (which is the fault under test, so it must not hang the test)
    const outcome = (promise) => Promise.race([
      promise.then((value) => ({ value }), (error) => ({ error })),
      turn().then(() => ({ waiting: true }))
    ]);
    async function refused(promise, pattern) {
      const out = await outcome(promise);
      assert.ok(out.error, out.waiting ? 'the invoke is left waiting' : `the invoke is answered with ${out.value}`);
      assert.match(out.error.message, pattern);
    }

    test('is logged once after 10 s, and its pending and later invokes reject saying so', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const app = withMains({ stuck: gated() });
      const { handlers, logs } = wire({ appRoot: app });
      plugins.activateMains();
      const pending = invoke(handlers, 'stuck', 'echo', 1);
      t.mock.timers.tick(9999);
      assert.deepEqual(await outcome(pending), { waiting: true }, 'nothing is refused inside 10 s');
      assert.deepEqual(logs, []);
      t.mock.timers.tick(1);
      await refused(pending, /\bstuck\b.*did not finish activating.*\becho\b/);
      assert.equal(logs.length, 1, logs.join('\n'));
      assert.match(logs[0], /^\[plugin stuck: activate\] .*did not finish activating within 10 s/);
      await refused(invoke(handlers, 'stuck', 'echo', 2), /\bstuck\b.*did not finish activating.*\becho\b/);
      assert.equal(logs.length, 1, 'later invokes add nothing to the log');
    });

    test('stays refused, and says nothing more, when it settles late or fails late', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const app = withMains({ slow: gated(), doomed: gated("throw new Error('failed late');") });
      const { handlers, logs } = wire({ appRoot: app });
      plugins.activateMains();
      t.mock.timers.tick(10000);
      await turn();
      assert.equal(logs.length, 2, logs.join('\n'));
      mainOf(app, 'slow').open();
      mainOf(app, 'doomed').open();
      await turn();
      for (const id of ['slow', 'doomed']) await refused(invoke(handlers, id, 'echo'), /did not finish activating/);
      assert.equal(logs.length, 2, logs.join('\n'));
    });

    test('is no matter when it settles in time: the plugin answers, and the limit never logs', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const app = withMains({ prompt: gated(), sync: "exports.activate = (host) => host.handle('echo', (p) => p);" });
      const { handlers, logs } = wire({ appRoot: app });
      plugins.activateMains();
      t.mock.timers.tick(9999);
      mainOf(app, 'prompt').open();
      assert.equal(await invoke(handlers, 'prompt', 'echo', 3), 3);
      assert.equal(await invoke(handlers, 'sync', 'echo', 4), 4);
      t.mock.timers.tick(60000);
      await turn();
      assert.deepEqual(logs, []);
      assert.equal(await invoke(handlers, 'prompt', 'echo', 5), 5);
    });

    test('has the limit that wire is given', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const app = withMains({ stuck: gated() });
      const { handlers, logs } = wire({ appRoot: app, activateMs: 500 });
      plugins.activateMains();
      t.mock.timers.tick(499);
      await turn();
      assert.deepEqual(logs, []);
      t.mock.timers.tick(1);
      await refused(invoke(handlers, 'stuck', 'echo'), /did not finish activating/);
      assert.match(logs[0], /did not finish activating within 0\.5 s/);
    });
  });

  // The window's preload asks main.js three things with sendSync, plugins:list
  // the last, and the window waits for the answers. A main entry's require
  // and the start of its activate run plugin code of any length, so no main
  // half starts before the window has its plugin list.
  test('a main half does not start until the window has its plugin list, and an invoke sent before waits for it', async () => {
    const app = withMains({ later: "let n = 0; exports.activate = (host) => { exports.starts = ++n; host.handle('echo', (p) => p); };" });
    const { handlers, logs } = wire({ appRoot: app, defer: null });
    plugins.activateMains();
    plugins.activateMains();
    const answer = invoke(handlers, 'later', 'echo', 7);
    await turn();
    assert.equal(mainOf(app, 'later').starts, undefined, 'activate has not run');
    const event = {};
    handlers.get('plugins:list')(event);
    assert.deepEqual(event.returnValue.map((m) => m.id), ['later']);
    assert.equal(mainOf(app, 'later').starts, undefined, 'nor while the list is being answered');
    assert.equal(await answer, 7);
    // a second window asking starts nothing again
    handlers.get('plugins:list')({});
    await turn();
    assert.equal(mainOf(app, 'later').starts, 1);
    assert.deepEqual(logs, []);
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

  // a window half that invokes from chapter-saved calls its handler on every
  // save, and the line goes into the same synced file
  test('a handler that fails every time is logged once, then at most once a minute with a count, and every invoke still rejects', async (t) => {
    const clock = { now: 0 };
    t.mock.method(performance, 'now', () => clock.now);
    const app = withMains({ keeper });
    const { handlers, logs } = wire({ appRoot: app });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    host.handle('throws', () => { throw new Error('throws every time'); });
    host.handle('rejects', async () => { throw new Error('rejects every time'); });
    const calls = async (n) => {
      for (let i = 0; i < n; i++) {
        await assert.rejects(invoke(handlers, 'keeper', 'throws'), /\bkeeper\b.*\bthrows\b.*throws every time/);
        await assert.rejects(invoke(handlers, 'keeper', 'rejects'), /\bkeeper\b.*\brejects\b.*rejects every time/);
      }
    };
    await calls(100);
    assert.equal(logs.length, 2, 'the first failure of each handler');
    assert.match(logs[0], /^\[plugin keeper: invoke throws\] Error: throws every time\n\s+at /);
    assert.match(logs[1], /^\[plugin keeper: invoke rejects\] Error: rejects every time\n\s+at /);
    clock.now += 59999;
    await calls(10);
    assert.equal(logs.length, 2);
    clock.now += 1;
    await calls(1);
    assert.equal(logs.length, 4);
    assert.match(logs[2], /^\[plugin keeper: invoke throws\] 109 more failures of this handler since its last line; the latest: Error: throws every time\n\s+at /);
    assert.match(logs[3], /^\[plugin keeper: invoke rejects\] 109 more failures of this handler since its last line; the latest: Error: rejects every time\n\s+at /);
    // a minute with none, and the next is logged as a first
    clock.now += 60000;
    await calls(1);
    assert.equal(logs.length, 6);
    assert.match(logs[4], /^\[plugin keeper: invoke throws\] Error: throws every time\n/);
  });

  test('one function that handles two channels is logged for each, once a minute, as a failure of each', async (t) => {
    const clock = { now: 0 };
    t.mock.method(performance, 'now', () => clock.now);
    const app = withMains({ keeper });
    const { handlers, logs } = wire({ appRoot: app });
    plugins.activateMains();
    const { host } = mainOf(app, 'keeper');
    const shared = () => { throw new Error('shared fails'); };
    host.handle('first', shared);
    host.handle('second', shared);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(invoke(handlers, 'keeper', 'first'), /shared fails/);
      await assert.rejects(invoke(handlers, 'keeper', 'second'), /shared fails/);
    }
    assert.equal(logs.length, 2, 'the first failure on each channel');
    assert.match(logs[0], /^\[plugin keeper: invoke first\] Error: shared fails\n/);
    assert.match(logs[1], /^\[plugin keeper: invoke second\] Error: shared fails\n/);
    clock.now += 60000;
    await assert.rejects(invoke(handlers, 'keeper', 'second'), /shared fails/);
    assert.equal(logs.length, 3);
    assert.match(logs[2], /^\[plugin keeper: invoke second\] 4 more failures of this handler since its last line; the latest: Error: shared fails\n/);
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

// main.js in a vm, as filesystem.test.js loads it, on the profile folder
// and app folder given. ready() runs what main.js does once Electron is
// ready, with the window, the menu, the spellchecker, the backup and the
// updater stood in for; ask() is a window's sendSync to a listener main.js
// registered with ipcMain.on. Loading main.js wires plugins-main.js anew,
// so only the last one loaded works.
function loadMain(profile, appDir) {
  const handlers = new Map();
  const listeners = new Map();
  const dialogs = [];
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
    ipcMain: { on: (channel, fn) => listeners.set(channel, fn), handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items) => items, setApplicationMenu() {} },
    dialog: { showMessageBox: async (...args) => { dialogs.push(args); return {}; } },
    utilityProcess: { fork: () => ({ on() {}, postMessage() {} }) },
    screen: {}
  };
  const localRequire = createRequire(path.join(root, 'main.js'));
  const libraryRoot = path.join(profile, 'documents', 'NEO Library');
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : localRequire(name),
    __dirname: appDir,
    process: { platform: process.platform, on() {} },
    console,
    setInterval: () => ({}),
    // startup schedules the iCloud fetch; nothing here waits for it
    setTimeout: () => ({ unref() {} }),
    libraryRoot
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: path.join(root, 'main.js') });
  // nothing is logged into the real Documents folder before ready() moves the library
  vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);
  return {
    dialogs,
    call: (channel, ...args) => handlers.get(channel)(null, ...args),
    ask(channel) {
      const event = {};
      listeners.get(channel)(event);
      return event.returnValue;
    },
    ready(order) {
      for (const name of ['createWindow', 'announceLibraryFallback', 'initSpell', 'buildMenu', 'dailyBackup', 'checkForUpdates']) {
        context[name] = () => { order.push(name); };
      }
      whenReady();
    }
  };
}

describe('main.js and the plugins\' main halves', { concurrency: 1 }, () => {
  // main.js in a vm (loadMain), on a temporary profile whose settings.json
  // already holds other settings
  let appDir = null; // main.js's own folder: a temporary one with the fixture plugins
  let probeMain = null;
  let profile = null;
  let main = null;
  const library = () => path.join(profile, 'documents', 'NEO Library');
  const errorLog = () => {
    try { return fs.readFileSync(path.join(library(), 'neo-errors.log'), 'utf8'); } catch { return ''; }
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  before(() => {
    appDir = fixtureApp(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-plugins-app-')));
    probeMain = path.join(appDir, fixtures, 'probe', 'main.js');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-plugins-main-'));
    fs.mkdirSync(path.join(profile, 'userData'));
    fs.writeFileSync(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ pageTheme: 'light', plugins: { other: { kept: true } } }));
    // read once, by the first test's ready()
    process.env.NEO_PLUGIN_DIRS = fixtures;
    main = loadMain(profile, appDir);
  });
  after(() => {
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(appDir, { recursive: true, force: true });
  });

  // The window's preload asks main.js three things synchronously (sendSync)
  // and the window waits for the answers; plugins:list is the last. Plugin
  // code of any length must run after them, not in the startup callback.
  test('the startup callback returns before any plugin code runs, and the main halves start a turn after the window has its plugin list', async (t) => {
    const order = [];
    const probe = require(probeMain);
    const activate = probe.activate;
    t.mock.method(probe, 'activate', (host) => { order.push('activate probe'); return activate(host); });
    main.ready(order);
    assert.equal(order[0], 'createWindow');
    assert.ok(order.length > 1, 'the rest of the startup ran');
    await turn();
    await turn();
    assert.ok(!order.includes('activate probe'), 'no plugin code runs before the window asks for its plugin list');
    const listed = main.ask('plugins:list');
    assert.ok(listed.some((m) => m.id === 'probe'), 'the list holds the probe');
    assert.ok(!order.includes('activate probe'), 'none runs while the list is being answered');
    await turn();
    assert.equal(order.at(-1), 'activate probe');
    const neo = windowNeo((channel, ...args) => main.call(channel, ...args));
    assert.deepEqual(await neo.pluginInvoke('probe', 'echo', { a: 1 }), { a: 1 });
    assert.doesNotMatch(errorLog(), /\b(startup|plugins)\b/);
  });

  // main.js wraps every ipcMain.handle: a rejection is logged under the
  // channel, and a refused write inside the library (EPERM, EACCES, EROFS)
  // opens a dialog saying NEO can't save. A plugin that writes a file of its
  // own in the library can fail so, with the writer's chapter already saved.
  test('a handler that fails logs once and opens no dialog, though its error looks like a refused write in the library', async () => {
    const { host } = require(probeMain);
    host.handle('refused', () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', path: path.join(library(), 'probe.json') });
    });
    const neo = windowNeo((channel, ...args) => main.call(channel, ...args));
    const before = errorLog();
    const errors = await Promise.all(['refused', 'fail'].map((channel) => neo.pluginInvoke('probe', channel).then(() => null, (err) => err)));
    await turn();
    assert.deepEqual(main.dialogs, [], 'no dialog');
    const added = errorLog().slice(before.length);
    assert.deepEqual(added.match(/^\[[^\]]+\] \[[^\]]+\]/gm).map((line) => line.replace(/^\[[^\]]+\] /, '')),
      ['[plugin probe: invoke refused]', '[plugin probe: invoke fail]']);
    assert.match(errors[0] && errors[0].message, /\bprobe\b.*\brefused\b.*EPERM/);
    assert.match(errors[1] && errors[1].message, /\bprobe\b.*\bfail\b.*failed on purpose/);
  });

  test('paths name the profile\'s library and userData folders and the probe\'s own folder', () => {
    const { host } = require(probeMain);
    assert.equal(host.paths.library(), library());
    assert.equal(host.paths.userData, path.join(profile, 'userData'));
    assert.equal(host.paths.plugin, path.join(appDir, fixtures, 'probe'));
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

describe('main halves when no window asks for the plugin list', { concurrency: 1 }, () => {
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  // a window whose preload failed to load never asks, and nothing may wait
  // on it for ever
  test('they start 5 s after startup all the same, and an invoke sent before waits for that', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    process.env.NEO_PLUGIN_DIRS = fixtures;
    const appDir = fixtureApp();
    const profile = tempFolder();
    fs.mkdirSync(path.join(profile, 'userData'));
    const probe = require(path.join(appDir, fixtures, 'probe', 'main.js'));
    const order = [];
    const activate = probe.activate;
    t.mock.method(probe, 'activate', (host) => { order.push('activate probe'); return activate(host); });
    const main = loadMain(profile, appDir);
    main.ready(order);
    await turn();
    t.mock.timers.tick(4999);
    await turn();
    assert.ok(!order.includes('activate probe'), 'not before the time is up');
    const neo = windowNeo((channel, ...args) => main.call(channel, ...args));
    const answer = neo.pluginInvoke('probe', 'echo', 3);
    t.mock.timers.tick(1);
    assert.equal(await answer, 3);
    assert.equal(order.at(-1), 'activate probe');
    // the window that asks late starts nothing twice
    main.ask('plugins:list');
    await turn();
    assert.equal(order.filter((name) => name === 'activate probe').length, 1);
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
  // the page: what it would add to the page, wherever it goes (an element's
  // remove() takes it off again), what it logs, and what it writes to the
  // console. reads stands in for app.js's getters; logError, when given,
  // for the log; clock.now is what performance.now() reads; invoked holds
  // what reached window.neo.pluginInvoke; fire(type, event) is the page
  // dispatching an event to the window's listeners; running(src, fn) runs
  // fn as the script loaded from src does.
  function windowHalf(list, reads = {}, logError = null) {
    const added = [];
    const logged = [];
    const consoled = [];
    const invoked = [];
    const clock = { now: 0 };
    const windowListeners = [];
    const page = { appendChild: (el) => added.push(el) };
    const element = (tag) => ({
      tag,
      dataset: {},
      setAttribute() {},
      addEventListener() {},
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
      // currentScript is plugins.js itself while it loads
      document: { head: page, body: page, addEventListener() {}, createElement: element, getElementById: () => page, currentScript: { src: 'plugins.js' } },
      addEventListener: (type, fn) => windowListeners.push([type, fn]),
      requestAnimationFrame: () => 1,
      performance: { now: () => clock.now },
      console: { error: (...args) => consoled.push(args.map(String).join(' ')) },
      structuredClone
    });
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(root, 'plugins.js'), 'utf8'), context, { filename: 'plugins.js' });
    context.document.currentScript = null;
    const getters = { book: () => null, chapterHTML: () => undefined, currentTab: () => 'manuscript', ...reads };
    const fire = (type, event) => windowListeners.filter(([t]) => t === type).forEach(([, fn]) => fn(event));
    // fn run as the script at src is, with document.currentScript naming it
    const running = (src, fn) => {
      context.document.currentScript = { src };
      try {
        return fn();
      } finally {
        context.document.currentScript = null;
      }
    };
    return { NeoPlugins: context.NeoPlugins, attach: () => context.NeoPlugins.attach(getters), added, logged, consoled, invoked, clock, fire, running, neo: context.neo };
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
    assert.match(logged[0], /^plugin p: chapter-saved: Error: thrown on purpose\n\s+at /);
    assert.match(logged[1], /^plugin p: chapter-saved: Error: rejected on purpose\n\s+at /);
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
      'plugin p: chapter-change: Symbol(change)',
      'plugin p: book-close: Symbol(boom)',
      'plugin p: book-close: (a value of type object with no text form)',
      'plugin p: book-close: Symbol(later)'
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
    assert.match(logged[0], /^plugin p: chapter-saved: Error: throws every time\n\s+at /);
    assert.match(logged[1], /^plugin p: chapter-saved: Error: rejects every time\n\s+at /);
    clock.now += 59999;
    await saves(10);
    assert.equal(logged.length, 2);
    clock.now += 1;
    await saves(1);
    assert.equal(logged.length, 4);
    assert.match(logged[2], /^plugin p: chapter-saved: 109 more failures of this listener since its last line; the latest: Error: throws every time\n\s+at /);
    assert.match(logged[3], /^plugin p: chapter-saved: 109 more failures of this listener since its last line; the latest: Error: rejects every time\n\s+at /);
    // a minute with none, and the next is logged as a first
    clock.now += 60000;
    await saves(1);
    assert.equal(logged.length, 6);
    assert.match(logged[4], /^plugin p: chapter-saved: Error: throws every time\n/);
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

  test('an error thrown in a plugin script before it registers is logged under its name and goes no further; its stylesheet leaves', () => {
    const styled = (id) => ({ id, apiVersion: 1, rendererUrl: `plugins/${id}/renderer.js`, styleUrl: `plugins/${id}/style.css` });
    const host = windowHalf(['works', 'early'].map(styled));
    host.attach();
    host.NeoPlugins.register({ id: 'works', apiVersion: 1, activate() {} });
    const links = () => host.added.filter((el) => el.tag === 'link').map((el) => el.href);
    assert.equal(links().length, 2);
    // a script's error as the page reports it: its filename is the script's URL
    const error = (filename, err) => {
      const event = { filename, lineno: 3, message: `Uncaught ${err.message}`, error: err, stopped: false, stopImmediatePropagation() { this.stopped = true; } };
      host.fire('error', event);
      return event.stopped;
    };
    assert.equal(error('plugins/early/renderer.js', new Error('early on purpose')), true);
    assert.match(host.logged[0], /^plugin early: Error: early on purpose\n\s+at /);
    assert.deepEqual(links(), ['plugins/works/style.css']);
    // one from a plugin that registered keeps its stylesheet, and is logged too
    assert.equal(error('plugins/works/renderer.js', new Error('late on purpose')), true);
    assert.match(host.logged[1], /^plugin works: Error: late on purpose\n\s+at /);
    assert.deepEqual(links(), ['plugins/works/style.css']);
    // a script of NEO's own is not the host's
    assert.equal(error('app.js', new Error('not a plugin')), false);
    assert.equal(host.logged.length, 2);
    // a thrown value that is no Error is logged by the page's message, once
    // the minute in which a plugin's errors are logged but once has passed
    host.clock.now += 60000;
    const plain = { filename: 'plugins/works/renderer.js', lineno: 9, message: 'Uncaught thrown', error: null, stopImmediatePropagation() {} };
    host.fire('error', plain);
    assert.equal(host.logged[2], 'plugin works: Uncaught thrown @ plugins/works/renderer.js:9');
  });

  // A promise a plugin drops and that rejects reaches the page as an
  // unhandled rejection, and NEO's net (app.js) would log it unlimited and
  // tell the writer. The host takes the ones that are a plugin's: those it
  // made for the plugin (an invoke refused, replace's TypeErrors, an invoke
  // after a failed activate) and those with a plugin's script in the stack.
  test('a rejection a plugin does not catch is logged under the plugin once a minute, and goes no further', async () => {
    const listed = (id) => ({ id, apiVersion: 2, rendererUrl: `plugins/${id}/renderer.js`, styleUrl: null });
    const host = windowHalf(['works', 'broken'].map(listed));
    host.attach();
    let neo = null;
    host.NeoPlugins.register({ id: 'works', apiVersion: 2, activate(api) { neo = api; } });
    let dead = null;
    host.NeoPlugins.register({ id: 'broken', apiVersion: 2, activate(api) { dead = api; throw new Error('broken on purpose'); } });
    const logged = () => host.logged.filter((line) => !line.includes('broken on purpose'));
    // what the page reports for a promise nobody handles
    const dropped = (reason) => {
      const event = { reason, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      host.fire('unhandledrejection', event);
      return event;
    };
    const taken = (event) => event.prevented && event.stopped;
    // an invoke the main half refuses: the Error preload.js makes from the answer
    host.neo.pluginInvoke = async () => { throw new Error('plugin works has no handler for index'); };
    assert.equal(taken(dropped(await neo.invoke('index', 1).catch((err) => err))), true);
    assert.equal(logged().length, 1);
    assert.match(logged()[0], /^plugin works: Error: plugin works has no handler for index\n\s+at /);
    // replace's TypeErrors, in the same minute: counted, and still taken
    assert.equal(taken(dropped(await neo.replace(null, '', '').catch((err) => err))), true);
    assert.equal(taken(dropped(await neo.replace({ chId: 'c', pIdx: 0, off: 0, len: 1 }, 'ab', '').catch((err) => err))), true);
    assert.equal(taken(dropped(await neo.replace({ chId: 'c', pIdx: 0, off: 0, len: 0 }, '', 'two\nlines').catch((err) => err))), true);
    assert.equal(logged().length, 1);
    // a minute on: the next is logged with the count
    host.clock.now += 60000;
    assert.equal(taken(dropped(await neo.replace(null, '', '').catch((err) => err))), true);
    assert.equal(logged().length, 2);
    assert.match(logged()[1], /^plugin works: 3 more failures of this plugin's script since its last line; the latest: TypeError: replace takes a place/);
    // the Error from invoking after a failed activate is the failed plugin's
    assert.equal(taken(dropped(await dead.invoke('index').catch((err) => err))), true);
    assert.match(logged()[2], /^plugin broken: Error: plugin broken is not active, so it cannot invoke index\n\s+at /);
    // A plugin's own callback that throws: the first frame that names a
    // script is the plugin's (one that names none, a builtin's, is passed
    // over). V8's frame for an anonymous async function has no name to
    // parse.
    const thrown = (message, ...frames) => Object.assign(new Error(message), { stack: [`Error: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join('\n') });
    host.clock.now += 60000;
    assert.equal(taken(dropped(thrown('a then callback throws', 'new Promise (<anonymous>)', 'plugins/works/renderer.js:12:30', 'async Promise.all (index 0)'))), true);
    assert.match(logged()[3], /^plugin works: Error: a then callback throws\n\s+at new Promise/);
    assert.equal(taken(dropped(thrown('after an await', 'async plugins/broken/renderer.js:7:5'))), true);
    assert.match(logged()[4], /^plugin broken: Error: after an await\n/);
    // the host answering a plugin's call (plugins.js frames, and no other
    // script before the plugin's) is the plugin's call
    host.clock.now += 60000;
    assert.equal(taken(dropped(thrown('status takes a string', 'setStatus (plugins.js:697:11)', 'Object.status (plugins.js:760:20)', 'plugins/works/renderer.js:3:3'))), true);
    assert.match(logged()[5], /^plugin works: Error: status takes a string\n/);
    // Anything else is NEO's, left to its net and not logged here: not an
    // Error with a stack, or any script but this file and the plugin's comes
    // before the plugin's first frame. NEO's own code is one: a bug in it
    // is not the plugin's, whatever plugin awaits it below (a dropped
    // reopen() that finds a NEO bug), or calls it (neo.replace reaching
    // app.js, which calls the host again and finds a bug there).
    const neos = [
      new Error('NEO\'s own'),
      Object.assign(new Error('app'), { stack: 'Error: app\n    at app.js:1:1' }),
      thrown('a NEO bug', 'openBook (app.js:2513:9)', 'async reopen (plugins/works/renderer.js:7:5)'),
      thrown('a NEO bug under a native frame', 'new Promise (<anonymous>)', 'openBook (app.js:2513:9)', 'async plugins/works/renderer.js:7:5'),
      thrown('NEO calls the host', 'emit (plugins.js:200:5)', 'run (app.js:11236:39)'),
      thrown('through NEO', 'showTab (plugins.js:640:5)', 'switchTab (app.js:7889:5)', 'go (plugins.js:359:9)', 'async plugins/broken/renderer.js:7:5'),
      thrown('a bug in NEO during a plugin\'s call', 'emit (plugins.js:200:5)', 'scheduleChapterSave (app.js:11277:5)', 'replace (plugins.js:480:12)', 'plugins/works/renderer.js:3:3'),
      'a string', undefined, null
    ];
    for (const reason of neos) {
      const event = dropped(reason);
      assert.deepEqual([event.prevented, event.stopped], [false, false], String(reason && reason.stack || reason));
    }
    assert.equal(logged().length, 6);
  });

  test('one function that listens to two events is logged for each, once a minute, and each line names its event', () => {
    const { NeoPlugins, neo, logged, clock } = withPlugin();
    const shared = () => { throw new Error('shared fails'); };
    neo.on('chapter-saved', shared);
    neo.on('book-close', shared);
    for (let i = 0; i < 5; i++) {
      NeoPlugins.emit('chapter-saved', { bookId: 'b', chId: 'c' });
      NeoPlugins.emit('book-close', { bookId: 'b' });
    }
    assert.equal(logged.length, 2, 'the first failure on each event');
    assert.match(logged[0], /^plugin p: chapter-saved: Error: shared fails\n\s+at /);
    assert.match(logged[1], /^plugin p: book-close: Error: shared fails\n\s+at /);
    clock.now += 60000;
    NeoPlugins.emit('book-close', { bookId: 'b' });
    assert.equal(logged.length, 3);
    assert.match(logged[2], /^plugin p: book-close: 4 more failures of this listener since its last line; the latest: Error: shared fails\n\s+at /);
  });

  test('an error the host throws for a plugin\'s own callback is credited to the plugin whose script is in its stack', () => {
    const styled = (id) => ({ id, apiVersion: 1, rendererUrl: `plugins/${id}/renderer.js`, styleUrl: null });
    const host = windowHalf(['works', 'other'].map(styled));
    host.attach();
    host.NeoPlugins.register({ id: 'works', apiVersion: 1, activate() {} });
    // an error the page reports from a file, with the stack its Error holds
    const error = (filename, ...frames) => {
      const stack = ['TypeError: status takes a string, not 42', ...frames.map((frame) => `    at ${frame}`)].join('\n');
      const event = { filename, lineno: 697, message: 'Uncaught TypeError: status takes a string, not 42', error: Object.assign(new TypeError('status takes a string, not 42'), { stack }), stopped: false, stopImmediatePropagation() { this.stopped = true; } };
      host.fire('error', event);
      return event.stopped;
    };
    // thrown in plugins.js, called from a callback in works' script: the first plugin frame
    assert.equal(error('plugins.js', 'setStatus (plugins.js:697:11)', 'Object.status (plugins.js:760:20)', 'plugins/works/renderer.js:12:30', 'plugins/other/renderer.js:3:3'), true);
    assert.match(host.logged[0], /^plugin works: TypeError: status takes a string, not 42\n\s+at setStatus /);
    // an async frame, from a function with a name
    assert.equal(error('plugins.js', 'setStatus (plugins.js:697:11)', 'async Timeout.tick (plugins/other/renderer.js:8:5)'), true);
    assert.match(host.logged[1], /^plugin other: TypeError/);
    // no plugin in the stack: left to NEO's net, as is an error from any other file
    assert.equal(error('plugins.js', 'setStatus (plugins.js:697:11)', 'app.js:16064:74', '<anonymous>:1:47'), false);
    assert.equal(error('app.js', 'plugins/works/renderer.js:12:30'), false);
    // NEO's own code between the host and the plugin (neo.replace reaching
    // app.js, which calls the host again and finds a bug there): not the plugin's
    assert.equal(error('plugins.js', 'emit (plugins.js:200:5)', 'scheduleChapterSave (app.js:11277:5)', 'replace (plugins.js:480:12)', 'plugins/works/renderer.js:3:3'), false);
    assert.equal(host.logged.length, 2);
    // and an error in plugins.js that holds no stack at all
    const bare = { filename: 'plugins.js', lineno: 1, message: 'Uncaught thrown', error: null, stopImmediatePropagation() { throw new Error('was stopped'); } };
    assert.doesNotThrow(() => host.fire('error', bare));
  });

  test('a plugin script that errors again and again is logged once, then at most once a minute with a count', () => {
    const host = windowHalf(['works', 'other'].map((id) => ({ id, apiVersion: 1, rendererUrl: `plugins/${id}/renderer.js`, styleUrl: null })));
    host.attach();
    // each error is stopped, so NEO's net never tells the writer, logged or not
    const error = (filename, message) => {
      const event = { filename, lineno: 3, message, error: new Error(message), stopped: false, stopImmediatePropagation() { this.stopped = true; } };
      host.fire('error', event);
      return event.stopped;
    };
    for (let i = 0; i < 110; i++) assert.equal(error('plugins/works/renderer.js', `tick ${i}`), true);
    assert.equal(host.logged.length, 1);
    assert.match(host.logged[0], /^plugin works: Error: tick 0\n\s+at /);
    // another plugin's first is its own line
    error('plugins/other/renderer.js', 'other ticks');
    assert.equal(host.logged.length, 2);
    // a minute on, the next is logged with the count of the 109 left out
    host.clock.now += 60000;
    error('plugins/works/renderer.js', 'tick 110');
    assert.equal(host.logged.length, 3);
    assert.match(host.logged[2], /^plugin works: 109 more failures of this plugin's script since its last line; the latest: Error: tick 110\n\s+at /);
    // and a minute with none, the next is a first
    host.clock.now += 60000;
    error('plugins/works/renderer.js', 'tick 111');
    assert.match(host.logged[3], /^plugin works: Error: tick 111\n/);
  });

  test('a script that registers under another id than its plugin.json is refused, and its own stylesheet leaves with it', () => {
    const styled = (id) => ({ id, apiVersion: 1, rendererUrl: `plugins/${id}/renderer.js`, styleUrl: `plugins/${id}/style.css` });
    const host = windowHalf(['works', 'wrong', 'stray'].map(styled));
    host.attach();
    const links = () => host.added.filter((el) => el.tag === 'link').map((el) => el.href);
    host.running('plugins/works/renderer.js', () => host.NeoPlugins.register({ id: 'works', apiVersion: 1, activate() {} }));
    host.running('plugins/wrong/renderer.js', () => host.NeoPlugins.register({ id: 'someone-else', apiVersion: 1, activate() {} }));
    assert.match(host.logged[0], /^plugin someone-else: not among the plugins NEO found at launch/);
    assert.deepEqual(links(), ['plugins/works/style.css', 'plugins/stray/style.css']);
    // a stray second register from a working plugin's script keeps its stylesheet
    host.running('plugins/works/renderer.js', () => host.NeoPlugins.register({ id: 'works', apiVersion: 1, activate() {} }));
    host.running('plugins/works/renderer.js', () => host.NeoPlugins.register({ id: 'someone-else', apiVersion: 1, activate() {} }));
    assert.deepEqual(links(), ['plugins/works/style.css', 'plugins/stray/style.css']);
    // a register from no script (a timer, an event) names no stylesheet but the id's own
    host.NeoPlugins.register({ id: 'stray', apiVersion: 99, activate() {} });
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
        assert.match(host.consoled[0], /^plugin p: chapter-saved: Error: a listener throws on purpose\n[\s\S]*Error: log down/);
        assert.match(host.consoled[1], /^plugin p: chapter-saved: Error: a listener rejects on purpose\n[\s\S]*Error: log down/);
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

  // A plugin that fails while the writer looks at its pane: the pane gives
  // way to the manuscript. Should that throw too, the plugin's own error
  // must still reach the log, and the rest of its things still go.
  test('a failing plugin\'s error is logged before what it added is cleared away, even when leaving its pane throws', async () => {
    for (const how of ['throws', 'rejects']) {
      const book = { id: 'owls', chapterOrder: [] };
      let tab = 'manuscript';
      const host = windowHalf([listedP], {
        book: () => book,
        currentTab: () => tab,
        switchTab: () => { throw new Error('switchTab fails on purpose'); }
      });
      host.attach();
      host.NeoPlugins.emit('book-open', { bookId: 'owls' });
      assert.doesNotThrow(() => host.NeoPlugins.register({ id: 'p', apiVersion: 1, activate(neo) {
        neo.addPane({ id: 'pane', title: 'Pane' });
        neo.status('Busy');
        tab = 'plugin:p:pane';
        const err = new Error(`activate ${how} on purpose`);
        if (how === 'throws') throw err;
        return Promise.reject(err);
      } }), how);
      await settled();
      assert.equal(host.logged.length, 2, host.logged.join('\n'));
      assert.match(host.logged[0], new RegExp(`^plugin p: Error: activate ${how} on purpose\\n\\s+at `), how);
      assert.match(host.logged[1], /^plugin p: .*switchTab fails on purpose/, how);
      assert.deepEqual(host.added.filter((el) => el.tag === 'div'), [], `${how}: its tab, pane and status are gone`);
    }
  });

  // a host with plugins api1 and api2 listed and registered, each written
  // for that API; neo holds what each was handed, by id
  function bothApis() {
    const host = windowHalf([1, 2].map((v) => ({ id: `api${v}`, apiVersion: v, rendererUrl: `plugins/api${v}/renderer.js`, styleUrl: null })));
    host.attach();
    const neo = {};
    for (const v of [1, 2]) {
      host.NeoPlugins.register({ id: `api${v}`, apiVersion: v, activate(api) { neo[`api${v}`] = api; } });
    }
    return { ...host, neo };
  }

  test('API 2 adds where, go, replace and highlight; a plugin written for API 1 is handed none of them', () => {
    const { NeoPlugins, neo } = bothApis();
    assert.deepEqual([...NeoPlugins.apiVersions], [1, 2]);
    assert.deepEqual(Object.keys(neo.api2).filter((name) => !(name in neo.api1)), ['where', 'go', 'replace', 'highlight']);
    assert.equal(neo.api1.where, undefined);
    assert.equal(neo.api1.go, undefined);
    assert.equal(neo.api1.replace, undefined);
    assert.equal(neo.api1.highlight, undefined);
  });

  test('highlight throws for a name, a list or a place that is not one', () => {
    const { neo } = bothApis();
    const place = { chId: 'c1', pIdx: 0, off: 0, len: 1 };
    for (const name of [undefined, 7, '', 'Claims', '9lives', 'a b', 'a:b', 'x'.repeat(33)]) {
      assert.throws(() => neo.api2.highlight(name, [place]), { name: 'TypeError', message: /\bname\b/ }, String(name));
    }
    for (const places of [undefined, null, place, 'c1', { length: 0 }]) {
      assert.throws(() => neo.api2.highlight('claims', places), { name: 'TypeError', message: /\blist of places\b/ }, String(places));
    }
    assert.throws(() => neo.api2.highlight('claims', [place, { ...place, len: -1 }]), { name: 'TypeError', message: /\bitem 1 is not a place\b.*"len":-1/ });
    for (const name of ['claims', 'a', 'x'.repeat(32), 'a-1']) {
      assert.doesNotThrow(() => neo.api2.highlight(name, [place, { ...place, scroll: 40 }]), name);
      assert.doesNotThrow(() => neo.api2.highlight(name, []), name);
    }
  });

  // Plugin ab's highlight c-d and plugin ab-c's d would both be
  // plugin-ab-c-d: the second to ask is refused, so neither clears or
  // disposes of the other's marks.
  test('a highlight\'s key belongs to the plugin that holds it until that plugin clears it', () => {
    const book = { id: 'owls', chapterOrder: ['c1'] };
    const host = windowHalf(['ab', 'ab-c'].map((id) => ({ id, apiVersion: 2, rendererUrl: `plugins/${id}/renderer.js`, styleUrl: null })), { book: () => book });
    host.attach();
    host.NeoPlugins.emit('book-open', { bookId: 'owls' });
    const neo = {};
    for (const id of ['ab', 'ab-c']) host.NeoPlugins.register({ id, apiVersion: 2, activate(api) { neo[id] = api; } });
    const places = [{ chId: 'c1', pIdx: 0, off: 0, len: 1 }];
    neo.ab.highlight('c-d', places);
    assert.throws(() => neo['ab-c'].highlight('d', places), { name: 'TypeError', message: /plugin-ab-c-d\b.*\bab\b/ });
    neo.ab.highlight('c-d', places);
    neo.ab.highlight('c-d', []);
    assert.doesNotThrow(() => neo['ab-c'].highlight('d', places));
    assert.throws(() => neo.ab.highlight('c-d', places), { name: 'TypeError', message: /plugin-ab-c-d\b.*\bab-c\b/ });
  });

  test('a place is captureCaret\'s shape with len, scroll optional, its numbers whole and never negative', () => {
    const { validPlace } = windowHalf([]).NeoPlugins;
    const place = { chId: 'c1', pIdx: 2, off: 5, len: 0 };
    for (const ok of [place, { ...place, scroll: 0 }, { ...place, scroll: 120.5 }, { ...place, len: 9 }]) {
      assert.equal(validPlace(ok), true, JSON.stringify(ok));
    }
    const refused = [
      undefined, null, 'c1', [], {},
      { pIdx: 0, off: 0, len: 0 }, { chId: '', pIdx: 0, off: 0, len: 0 }, { chId: 7, pIdx: 0, off: 0, len: 0 },
      { chId: 'c1', off: 0, len: 0 }, { chId: 'c1', pIdx: 0, len: 0 }, { chId: 'c1', pIdx: 0, off: 0 },
      { ...place, pIdx: -1 }, { ...place, off: 1.5 }, { ...place, len: '3' }, { ...place, off: Infinity },
      { ...place, scroll: -1 }, { ...place, scroll: null }, { ...place, scroll: NaN }, { ...place, scroll: '10' },
      { ...place, note: 'a key a place does not have' }
    ];
    for (const bad of refused) assert.equal(validPlace(bad), false, String(JSON.stringify(bad)));
  });

  test('go throws for what is not a place, and moves nothing with no book open or for a plugin that failed to activate', () => {
    const { neo } = bothApis();
    assert.throws(() => neo.api2.go({ chId: 'c1', pIdx: -1, off: 0, len: 0 }), { name: 'TypeError', message: /\bplace\b.*"pIdx":-1/ });
    assert.throws(() => neo.api2.go(), { name: 'TypeError', message: /\bplace\b.*undefined/ });
    const cyclic = { chId: 'c1' };
    cyclic.self = cyclic;
    assert.throws(() => neo.api2.go(cyclic), { name: 'TypeError', message: /\bplace\b/ });
    assert.equal(neo.api2.go({ chId: 'c1', pIdx: 0, off: 0, len: 0 }), false, 'no book is open');
    assert.equal(neo.api2.where(), null);
    // the book is open, but the plugin's activate failed
    const book = { id: 'owls', chapterOrder: ['c1'] };
    const host = windowHalf([{ id: 'p', apiVersion: 2, rendererUrl: 'plugins/p/renderer.js', styleUrl: null }], { book: () => book });
    host.attach();
    host.NeoPlugins.emit('book-open', { bookId: 'owls' });
    let failed = null;
    host.NeoPlugins.register({ id: 'p', apiVersion: 2, activate(api) { failed = api; throw new Error('activate fails on purpose'); } });
    assert.equal(failed.go({ chId: 'c1', pIdx: 0, off: 0, len: 0 }), false);
  });

  // what a plugin is handed, in every API this NEO knows, is listed where a
  // reader of plugins.js starts, as calls; and so is what else a plugin's
  // script can reach
  test('the comment at the top of plugins.js names every call a plugin is handed, and what its script can reach besides', () => {
    const source = fs.readFileSync(path.join(root, 'plugins.js'), 'utf8');
    const head = source.slice(0, source.indexOf('\'use strict\''));
    const versions = [...windowHalf([]).NeoPlugins.apiVersions];
    const host = windowHalf(versions.map((v) => ({ id: `api${v}`, apiVersion: v, rendererUrl: `plugins/api${v}/renderer.js`, styleUrl: null })));
    host.attach();
    const calls = new Set();
    for (const v of versions) {
      host.NeoPlugins.register({ id: `api${v}`, apiVersion: v, activate(neo) { for (const name of Object.keys(neo)) calls.add(name); } });
    }
    assert.ok(calls.has('on') && calls.has('invoke'), [...calls].join(', '));
    assert.deepEqual([...calls].filter((name) => !new RegExp(`\\b${name}\\(`).test(head)), [], head);
    assert.match(head, /\bwindow\.neo\b/, 'it says window.neo is in reach of any plugin script');
    assert.match(head, /\btrust/, 'and which plugins NEO trusts because of it');
    assert.match(head, /\bapp folder\b/, 'it says where those plugins load from: the app folder');
    assert.match(head, /\bnot packaged\b[^.]*\bNEO_PLUGIN_DIRS\b/, 'and, when NEO is not packaged, the folders in NEO_PLUGIN_DIRS');
  });

  // go and replace find their place through rangeOfPlace, and a highlight
  // its places through rangesOfPlaces. With rangeOfPlace no more than
  // rangesOfPlaces for one place, a rule added to either holds for all
  // three; a second copy of the rules could drift from the first.
  test('rangeOfPlace is rangesOfPlaces for one place, so go, replace and highlight resolve a place alike', () => {
    const source = fs.readFileSync(path.join(root, 'plugins.js'), 'utf8');
    const at = source.indexOf('function rangeOfPlace(');
    assert.ok(at >= 0, 'plugins.js defines rangeOfPlace');
    const body = source.slice(at, at + source.slice(at).search(/\r?\n {2}\}\r?\n/));
    assert.match(body, /\brangesOfPlaces\(\[place\]\)/, body);
    assert.doesNotMatch(body, /\bpointIn\(|\bbodyOf\(|\bchapterOrder\b|\bcreateRange\(/, 'it finds nothing on the page itself');
  });
});
