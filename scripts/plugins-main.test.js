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
function wire({ appRoot = root, isPackaged = false, dirs } = {}) {
  if (dirs === undefined) delete process.env.NEO_PLUGIN_DIRS;
  else process.env.NEO_PLUGIN_DIRS = dirs;
  const logs = [];
  const handlers = new Map();
  plugins.wire({
    app: { isPackaged },
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
    assert.equal(event.returnValue, list);
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
  });
});
