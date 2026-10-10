import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { compileFunction, createContext, runInContext, Script } from 'node:vm';

const root = fileURLToPath(new URL('../..', import.meta.url));
const realRequire = createRequire(path.join(root, 'package.json'));

// Each of these starts an Electron main process that goes on to require NEO's main.js. The
// test runs everything before that require, then main.js itself, against stand-ins for
// Electron and a decoy for the developer's machine, and checks that nothing in them can
// reach anything but the temp folder of the run.
type Target = {
  file: string;
  entry: RegExp;
  // Names its temp folder in NEO_TEST_PROFILE, as the Playwright harness does.
  profile: boolean;
  // What it answers rather than refuses.
  answers: string[];
};
const TARGETS: Target[] = [
  { file: 'scripts/plugins.e2e.js', entry: /^require\('\.\.\/main\.js'\);?$/m, profile: false, answers: [] },
  { file: 'scripts/plugin-edits.e2e.js', entry: /^require\('\.\.\/main\.js'\);?$/m, profile: false, answers: [] },
  {
    file: 'tests/support/electron-main.cjs',
    entry: /^require\('\.\.\/\.\.\/main\.js'\);?$/m,
    profile: true,
    answers: [
      'dialog.showOpenDialog', 'dialog.showSaveDialog', 'dialog.showMessageBox', 'dialog.showErrorBox',
      'shell.trashItem',
    ],
  },
];

// What Electron has today; the stand-ins hold a real call of each.
const DIALOG = [
  'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync',
  'showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showCertificateTrustDialog',
];
const SHELL = [
  'showItemInFolder', 'openPath', 'openExternal', 'trashItem', 'beep', 'writeShortcutLink', 'readShortcutLink',
];
const PROGRAMS = ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync'];
const FOLDERS = ['userData', 'documents', 'temp', 'home', 'appData', 'desktop', 'downloads', 'music', 'pictures', 'videos'];
const VARIABLES = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'];

type Anything = any; // the stand-ins are loose on purpose

type Run = {
  sandbox: string;
  developer: string;
  systemTmp: string;
  // The folder the run made for itself: where everything it does must stay.
  tempRoot: string;
  paths: Map<string, string>;
  env: Record<string, string>;
  electron: Anything;
  os: Anything;
  fs: Anything;
  childProcess: Anything;
  moduleLoader: Anything;
  context: Anything;
  main: { dir: string; file: string; logged: string };
};

const inside = (parent: string, child: unknown): boolean => {
  if (typeof child !== 'string') return false;
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

// Runs the target's setup, then main.js, in a vm of stand-ins. `developer` is where the
// developer's own folders would be: a decoy, so that a run that reaches them writes into a
// folder this test then finds not empty, not into the real one.
function run(target: Target): Run {
  const sandbox = mkdtempSync(path.join(realpathSync(tmpdir()), 'hoard-isolation-'));
  const developer = path.join(sandbox, 'developer');
  const systemTmp = path.join(sandbox, 'system-tmp');
  mkdirSync(developer);
  mkdirSync(systemTmp);
  const profileDir = path.join(sandbox, 'profile');
  if (target.profile) mkdirSync(profileDir);

  const paths = new Map<string, string>();
  const real = () => 'a real call';
  const electron: Anything = {
    app: {
      setPath: (name: string, to: string) => paths.set(name, to),
      getPath: (name: string) => paths.get(name) ?? path.join(developer, 'electron', name),
      commandLine: { appendSwitch() {}, hasSwitch: () => false },
      on() {},
      whenReady: () => ({ then() {} }),
      requestSingleInstanceLock: () => true,
      getLocale: () => 'en',
      getVersion: () => '0.0.0',
      isPackaged: false,
    },
    BrowserWindow: { prototype: { loadFile() {}, show() {} }, getFocusedWindow: () => null, getAllWindows: () => [] },
    session: { defaultSession: { webRequest: { onBeforeRequest() {} } } },
    ipcMain: { on() {}, handle() {} },
    Menu: { buildFromTemplate: (items: unknown) => items, setApplicationMenu() {} },
    MenuItem: class {},
    screen: {},
    dialog: Object.fromEntries(DIALOG.map((name) => [name, real])),
    shell: Object.fromEntries(SHELL.map((name) => [name, real])),
    systemPreferences: {},
    utilityProcess: { fork: real },
  };
  const env: Record<string, string> = Object.fromEntries(VARIABLES.map((name) => [name, path.join(developer, name)]));
  env.TEMP = env.TMP = env.TMPDIR = systemTmp;
  if (target.profile) env.NEO_TEST_PROFILE = profileDir;
  // Copies, so that what the setup patches is the stand-ins', never this process's own.
  const fakeOs: Anything = { ...os, homedir: () => developer, tmpdir: () => systemTmp };
  const fakeFs: Anything = { ...fs, promises: { ...fs.promises } };
  const fakeChildProcess: Anything = { ...childProcess };
  const moduleLoader: Anything = { _load: (request: string) => `loaded ${request}` };
  const fakeProcess = {
    pid: process.pid, env, platform: process.platform, versions: process.versions, argv: [], kill: process.kill, on() {},
  };

  // Timers that never fire: main.js arms some when it loads, and nothing here may run on.
  const context: Anything = createContext({
    process: fakeProcess,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    setImmediate: () => 0,
    clearTimeout() {},
    clearInterval() {},
    Buffer,
    URL,
    TextDecoder,
    TextEncoder,
    queueMicrotask,
  });
  const names: Record<string, unknown> = {
    electron, os: fakeOs, fs: fakeFs, child_process: fakeChildProcess, module: moduleLoader,
  };
  const cache = new Map<string, { exports: unknown }>();
  const requireFrom = (dir: string) => (request: string): unknown => {
    const name = request.replace(/^node:/, '');
    if (name in names) return names[name];
    if (!request.startsWith('.')) return realRequire(request);
    const file = path.resolve(dir, request);
    if (!cache.has(file)) {
      const module = { exports: {} };
      cache.set(file, module);
      const wrapper = compileFunction(
        readFileSync(file, 'utf8'), ['exports', 'require', 'module', '__filename', '__dirname'],
        { parsingContext: context, filename: file },
      );
      wrapper.call(module.exports, module.exports, requireFrom(path.dirname(file)), module, file, path.dirname(file));
    }
    return cache.get(file)!.exports;
  };

  const file = path.join(root, target.file);
  const source = readFileSync(file, 'utf8');
  const entry = target.entry.exec(source);
  assert.ok(entry, `${target.file} requires main.js on a line of its own`);
  compileFunction(
    source.slice(0, entry.index), ['require', '__filename', '__dirname'],
    { parsingContext: context, filename: file },
  )(requireFrom(path.dirname(file)), file, path.dirname(file));

  // main.js reads os.homedir() when it loads, to start LIBRARY_DIR and LIBRARY_FILE.
  context.require = requireFrom(root);
  context.__dirname = root;
  new Script(readFileSync(path.join(root, 'main.js'), 'utf8'), { filename: 'main.js' }).runInContext(context);

  const made = readdirSync(systemTmp).filter((name) => /^neo-(plugins|plugin-edits)-test-/.test(name));
  const tempRoot = target.profile ? profileDir : path.join(systemTmp, made[0] ?? 'no-folder-was-made');
  const result: Run = {
    sandbox, developer, systemTmp, tempRoot, paths, env, electron,
    os: fakeOs, fs: fakeFs, childProcess: fakeChildProcess, moduleLoader, context,
    main: { dir: '', file: '', logged: '' },
  };
  result.main.dir = runInContext('LIBRARY_DIR', context);
  result.main.file = runInContext('LIBRARY_FILE', context);
  return result;
}

// What is in the developer's decoy folders, as paths below it.
function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(prefix, entry.name);
    return entry.isDirectory() ? [rel, ...walk(path.join(dir, entry.name), rel)] : [rel];
  });
}

for (const target of TARGETS) {
  describe(target.file, () => {
    let r: Run;
    before(() => { r = run(target); });
    after(() => { rmSync(r.sandbox, { recursive: true, force: true }); });

    test('makes a temp folder of its own, in the system temp folder', () => {
      assert.ok(inside(target.profile ? r.sandbox : r.systemTmp, r.tempRoot));
      assert.ok(readdirSync(r.tempRoot) !== undefined, 'it exists');
    });

    test('names every folder Electron has inside it', () => {
      for (const name of FOLDERS) {
        assert.ok(inside(r.tempRoot, r.paths.get(name)), `${name} is ${r.paths.get(name)}`);
      }
    });

    test('points the variables that name a user\'s folders into it', () => {
      for (const name of VARIABLES) assert.ok(inside(r.tempRoot, r.env[name]), `${name} is ${r.env[name]}`);
    });

    test('moves os.homedir and os.tmpdir into it', () => {
      assert.ok(inside(r.tempRoot, r.os.homedir()), `homedir is ${r.os.homedir()}`);
      assert.ok(inside(r.tempRoot, r.os.tmpdir()), `tmpdir is ${r.os.tmpdir()}`);
    });

    test('refuses every dialog and shell call it does not answer', async () => {
      for (const [owner, label] of [[r.electron.dialog, 'dialog'], [r.electron.shell, 'shell']] as const) {
        for (const [name, call] of Object.entries<() => unknown>(owner)) {
          if (target.answers.includes(`${label}.${name}`)) continue;
          assert.equal((call as Anything).neoTestStub, true, `${label}.${name} is a stub`);
          // A call that answers at once must throw at once: a promise would read as its answer.
          if (name.endsWith('Sync')) assert.throws(call, /disabled in tests/, `${label}.${name} throws`);
          else await assert.rejects(async () => call(), /disabled in tests/, `${label}.${name} rejects`);
        }
      }
    });

    test('writes no macOS defaults', () => {
      const set = r.electron.systemPreferences.setUserDefault;
      assert.equal(typeof set, 'function');
      assert.equal(set.neoTestStub, true);
      assert.doesNotThrow(() => set('ApplePressAndHoldEnabled', 'boolean', false));
    });

    test('starts no program', () => {
      for (const name of PROGRAMS) {
        assert.equal(r.childProcess[name].neoTestStub, true, `${name} is a stub`);
        assert.throws(() => r.childProcess[name]('osascript'), /disabled in tests/, `${name} throws`);
      }
    });

    test('opens no connection', async () => {
      await assert.rejects(runInContext("fetch('https://example.com')", r.context), /Network access is disabled/);
      assert.throws(() => r.moduleLoader._load('electron-updater'), /disabled in tests/);
      assert.equal(r.moduleLoader._load('jszip'), 'loaded jszip');
    });

    test('writes only inside the temp folder', () => {
      const outside = path.join(r.sandbox, 'outside.txt');
      assert.throws(() => r.fs.writeFileSync(outside, 'x'), { code: 'TEST_WRITE_OUTSIDE_PROFILE' });
      assert.throws(() => r.fs.mkdirSync(path.join(r.sandbox, 'elsewhere')), { code: 'TEST_WRITE_OUTSIDE_PROFILE' });
      const within = path.join(r.tempRoot, 'inside.txt');
      assert.doesNotThrow(() => r.fs.writeFileSync(within, 'x'));
      assert.equal(readFileSync(within, 'utf8'), 'x');
    });

    test('main.js starts with its library inside the temp folder', () => {
      assert.ok(inside(r.tempRoot, r.main.dir), `LIBRARY_DIR is ${r.main.dir}`);
      assert.ok(inside(r.tempRoot, r.main.file), `LIBRARY_FILE is ${r.main.file}`);
    });

    // logError makes the library folder, seeds library.json and appends to neo-errors.log, and
    // an exception before main.js has found the library goes through it.
    test('an error logged before the library is found cannot write outside the temp folder', () => {
      runInContext("logError('early', new Error('before the library is found'))", r.context);
      assert.deepEqual(walk(r.developer), [], 'nothing was made in the developer\'s folders');
      const log = path.join(r.main.dir, 'neo-errors.log');
      assert.match(readFileSync(log, 'utf8'), /before the library is found/);
    });
  });
}

// A copy of this process's fs is patched above; the real one must be as it was.
test('the stand-ins did not touch this process', () => {
  assert.equal((fs.writeFileSync as Anything).neoTestStub, undefined);
  assert.equal((childProcess.execFile as Anything).neoTestStub, undefined);
  writeFileSync(path.join(tmpdir(), `hoard-isolation-probe-${process.pid}`), 'ok');
  rmSync(path.join(tmpdir(), `hoard-isolation-probe-${process.pid}`));
});
