// Cuts a test's Electron main process off from the developer's machine, so that a run reaches
// none of their folders, library, settings, programs or network.
//
// Call isolate() before requiring NEO's main.js. main.js reads os.homedir() when it loads, to
// start LIBRARY_DIR and LIBRARY_FILE at ~/Documents/NEO Library, and an error logged before it
// has found the library (an exception or a rejection at launch) makes that folder, seeds
// library.json in it and appends to neo-errors.log. With the home folder inside the run's temp
// folder, that library is the run's own.
//
// scripts/plugins.e2e.js, scripts/plugin-edits.e2e.js and the Playwright harness
// (tests/support/electron-main.cjs) all use this, so they are isolated in the same way.

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const workerThreads = require('worker_threads');

// The variables that name a user's folders. Child processes, Chromium and libraries read these
// and not Electron's paths.
function variables(profile) {
  const tmp = path.join(profile, 'tmp');
  return {
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, 'appData'),
    LOCALAPPDATA: path.join(profile, 'localAppData'),
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    // Linux: where Chromium and libraries keep their settings, data, caches and state
    XDG_CONFIG_HOME: path.join(profile, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(profile, 'xdg', 'data'),
    XDG_CACHE_HOME: path.join(profile, 'xdg', 'cache'),
    XDG_STATE_HOME: path.join(profile, 'xdg', 'state')
  };
}

// A stub carries a mark, so that a test can tell it from the call Electron implements.
function stubbed(fn) {
  return Object.assign(fn, { neoTestStub: true });
}

// Replaces functions of `owner` (all of them by default) with ones that throw. A call that
// answers at once must throw at once: a rejected promise in its place would read as an answer
// (a truthy one).
function refuse(owner, label, { names = Object.keys(owner), answersAtOnce = () => false } = {}) {
  for (const name of names) {
    // a function and not an arrow, so that `new` on a refused class reaches the throw
    const fail = function () { throw new Error(label + '.' + name + ' is disabled in tests'); };
    owner[name] = stubbed(answersAtOnce(name) ? fail : async () => fail());
  }
}

// Makes every function of fs that writes, links or moves refuse a path outside `profile`. It
// guards JavaScript's fs and is not a sandbox. What it cannot stop:
//   - process.binding('fs') and internalBinding, which are the functions under fs;
//   - native code: addons, process.dlopen and FFI such as the koffi that main.js loads on macOS;
//   - Chromium's own writes (cache, cookies, crash dumps, downloads) and Electron's native
//     writers, such as webContents.savePage;
//   - a function of fs that code took before isolate() ran, which is still the original;
//   - writers that call no fs function: node:sqlite DatabaseSync(path), v8.writeHeapSnapshot(path)
//     and process.report.writeReport(path);
//   - the spell worker's utility process, which has an fs of its own, unguarded.
// Other routes to fs are closed in isolate(): original-fs, import(), getBuiltinModule and
// worker threads.
function guardWrites(profile, onRefuse = () => {}) {
  const root = path.resolve(profile);
  // The profile may sit below a link (macOS keeps /var/folders under /private/var), so a path
  // is inside if it is inside the profile as named or as the system resolves it.
  const roots = [...new Set([root, fs.realpathSync(root)])];
  const deny = (method) => {
    onRefuse({ event: 'test.write-refused', method });
    throw Object.assign(new Error('Test write leaves its ordinary disposable profile'), { code: 'TEST_WRITE_OUTSIDE_PROFILE' });
  };
  if (fs.lstatSync(root).isSymbolicLink()) deny('profile');

  const check = (target, method) => {
    if (target instanceof URL) target = fileURLToPath(target);
    if (Buffer.isBuffer(target)) target = target.toString();
    if (typeof target !== 'string') deny(method);
    const absolute = path.resolve(target);
    const home = roots.find((candidate) => {
      const suffix = path.relative(candidate, absolute);
      return !path.isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + path.sep);
    });
    if (!home) deny(method);
    let current = home;
    for (const part of path.relative(home, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (stat.isSymbolicLink()) deny(method);
    }
  };
  // A guarded function carries a mark, so that a test can tell it from one the guard missed.
  const guarded = (fn) => Object.assign(fn, { neoTestGuard: true });
  const wrap = (owner, name, indices, asynchronous = false) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    const invoke = (...args) => {
      for (const index of indices) check(args[index], name);
      return original.apply(owner, args);
    };
    owner[name] = guarded(asynchronous ? async (...args) => invoke(...args) : invoke);
  };
  // mkdtemp and mkdtempDisposable take the path their folder's name starts with.
  for (const name of [
    'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'mkdtempDisposable', 'unlink', 'rm', 'rmdir', 'truncate',
    'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes'
  ]) {
    wrap(fs, name + 'Sync', [0]);
    wrap(fs, name, [0]);
    wrap(fs.promises, name, [0], true);
  }
  for (const name of ['rename', 'copyFile', 'cp', 'link']) {
    wrap(fs, name + 'Sync', [0, 1]);
    wrap(fs, name, [0, 1]);
    wrap(fs.promises, name, [0, 1], true);
  }
  wrap(fs, 'createWriteStream', [0]);
  const writable = (flags) => typeof flags === 'string'
    ? /[wa+]/.test(flags)
    : !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
  for (const [owner, name, asynchronous] of [[fs, 'openSync', false], [fs, 'open', false], [fs.promises, 'open', true]]) {
    const original = owner[name];
    const invoke = (...args) => {
      if (writable(args[1])) check(args[0], name);
      return original.apply(owner, args);
    };
    owner[name] = guarded(asynchronous ? async (...args) => invoke(...args) : invoke);
  }
  for (const name of ['symlinkSync', 'symlink']) fs[name] = guarded(() => deny(name));
  fs.promises.symlink = guarded(async () => deny('symlink'));
}

// Keeps every window a test opens off the screen and out of the keyboard's way, for whoever is
// working on the machine while the suites run. NEO_TEST_VISIBLE=1 turns it off, for a manual
// session that wants to see the window.
//
// Mechanism: every BrowserWindow that code loaded afterwards makes is made with show: false and
// webPreferences.offscreen: true, so it is never put on the screen, and its page is drawn into
// memory at 60 frames a second. Hidden only (show: false, with paintWhenInitiallyHidden and
// backgroundThrottling off) was tried first: the page's animation frames then came about twice a
// second in NEO's own window, and the plugin host's selection and chapter-change events, which
// are sent once a frame, arrived late or not within a test's wait. The calls that would bring a
// window forward do nothing, so that code under test cannot undo it: show, showInactive, focus,
// moveTop, restore and maximize, and app.focus. A window is never shown, rather than shown off
// every display or shown inactive: Windows gives even an inactive or off-screen window a
// taskbar button and a place in Alt+Tab. With no window shown, BrowserWindow.getFocusedWindow()
// is null; an offscreen page still reports focus to its own scripts.
//
// Every window event that matters is recorded in globalThis.neoTestWindowEvents, and appended as
// JSON lines to the file NEO_TEST_WINDOW_LOG names, when it is set: a run can be checked for a
// window that flashed up without anyone watching the screen.
function hideWindows() {
  const electron = require('electron');
  const { app } = electron;
  if (globalThis.neoTestWindowEvents) return; // already done: the patches below do not stack
  const log = process.env.NEO_TEST_WINDOW_LOG;
  // Taken before guardWrites replaces openSync: the log is outside the profile. Not appendFileSync,
  // which calls the guarded writeFileSync.
  const { openSync, writeSync, closeSync } = fs;
  const append = (file, text) => {
    const fd = openSync(file, 'a');
    try { writeSync(fd, text); } finally { closeSync(fd); }
  };
  const events = globalThis.neoTestWindowEvents = [];
  const record = (win, event) => {
    const entry = { t: Date.now(), pid: process.pid, id: win.id, event };
    if (!win.isDestroyed()) Object.assign(entry, { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() });
    events.push(entry);
    if (log) try { append(log, JSON.stringify(entry) + '\n'); } catch { /* a log that cannot be written must not fail a test */ }
  };
  app.on('browser-window-created', (_event, win) => {
    record(win, 'created');
    for (const event of ['show', 'focus', 'restore', 'maximize', 'minimize']) win.on(event, () => record(win, event));
  });
  if (process.env.NEO_TEST_VISIBLE === '1') return;

  const Base = electron.BrowserWindow;
  // A subclass does not work: the object Electron builds does not take the subclass's prototype,
  // and getAllWindows, which filters by instanceof, then finds none. A proxy of the class changes
  // only the options of a construction, and is the same class for everything else.
  const HiddenBrowserWindow = new Proxy(Base, {
    construct: (target, [options = {}]) => Reflect.construct(target, [{
      ...options,
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true }
    }])
  });
  // electron's BrowserWindow export cannot be redefined, so a require of 'electron' gets a view
  // of the module with the hidden class in its place. Instances are ordinary BrowserWindows:
  // getAllWindows, fromWebContents and instanceof see the same objects.
  const view = new Proxy(electron, { get: (target, key) => key === 'BrowserWindow' ? HiddenBrowserWindow : Reflect.get(target, key) });
  const load = Module.prototype.require;
  Module.prototype.require = function (id) {
    const loaded = load.apply(this, arguments);
    return id === 'electron' ? view : loaded;
  };
  for (const name of ['show', 'showInactive', 'focus', 'moveTop', 'restore', 'maximize']) Base.prototype[name] = stubbed(() => {});
  app.focus = stubbed(() => {});
}

// `profile` is the run's temp folder: everything the run does stays inside it. `userData` and
// `documents` are where NEO keeps its settings and its default library, inside it by default.
function isolate(profile, {
  userData = path.join(profile, 'userData'),
  documents = path.join(profile, 'documents')
} = {}) {
  const { app, dialog, session, shell, systemPreferences, utilityProcess } = require('electron');
  const env = variables(profile);

  hideWindows();
  Object.assign(process.env, env);
  os.homedir = () => profile;
  os.tmpdir = () => env.TMP;
  guardWrites(profile, (event) => console.warn(JSON.stringify(event)));
  for (const dir of new Set([...Object.values(env), userData, documents])) fs.mkdirSync(dir, { recursive: true });

  app.setPath('userData', userData);
  app.setPath('documents', documents);
  app.setPath('temp', env.TMP);
  // main.js falls back on `home` for a library, and a library there would be the real one.
  // sessionData, logs and crashDumps already follow userData.
  app.setPath('home', profile);
  app.setPath('appData', env.APPDATA);
  for (const name of ['desktop', 'downloads', 'music', 'pictures', 'videos']) {
    app.setPath(name, path.join(profile, name));
  }
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  // safeStorage keeps main.js's API key. On macOS it would reach the developer's Keychain, and
  // on Linux their keyring (gnome-libsecret or kwallet); these keep it to a mock and a plain file.
  app.commandLine.appendSwitch('use-mock-keychain');
  app.commandLine.appendSwitch('password-store', 'basic');

  // Every dialog is refused, the synchronous ones included: at launch main.js asks
  // showMessageBoxSync and showOpenDialogSync when the chosen library folder is missing or
  // unwritable, and catches the throw. A script that needs an answer replaces one afterwards.
  refuse(dialog, 'dialog', { answersAtOnce: (name) => name.endsWith('Sync') });
  // No browser, file manager, file or shortcut is reached, whatever Electron adds to shell.
  refuse(shell, 'shell');
  // macOS: main.js sets the app's user defaults at every launch, which would write to the
  // developer's own. Nothing is written.
  systemPreferences.setUserDefault = stubbed(() => {});
  // macOS: email:draft runs osascript. No program starts during a test, by this route.
  refuse(childProcess, 'child_process', {
    names: ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync'],
    answersAtOnce: () => true
  });
  // A worker thread has an fs of its own, which no patch to this one reaches.
  refuse(workerThreads, 'worker_threads', { names: ['Worker'], answersAtOnce: () => true });

  // main.js forks one utility process, the spell worker. No other process starts, by this
  // route either; that one is the only module the fork is let through for.
  const fork = utilityProcess.fork;
  const spellWorker = path.resolve(__dirname, '..', 'spell-worker.js');
  const isSpellWorker = (modulePath) => {
    if (path.resolve(String(modulePath)) === spellWorker) return true;
    try { return fs.realpathSync.native(modulePath) === fs.realpathSync.native(spellWorker); } catch { return false; }
  };
  utilityProcess.fork = stubbed(function (modulePath, ...args) {
    if (!isSpellWorker(modulePath)) {
      throw new Error('utilityProcess.fork is disabled in tests, except for spell-worker.js: ' + modulePath);
    }
    return fork.call(utilityProcess, modulePath, ...args);
  });

  // The window reaches no server either: an image in a chapter, a plugin's fetch in the page.
  // Pages of the app itself load from files, which these patterns do not match.
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  ));

  globalThis.fetch = stubbed(async () => { throw new Error('Network access is disabled in tests'); });
  // Electron's original-fs is fs without the guard above, which a plugin's main half could load
  // by require, by import() or by getBuiltinModule; electron-updater would look for an update.
  const isOriginalFs = (id) => /^(node:)?original-fs(\/|$)/.test(String(id));
  if (typeof Module.registerHooks !== 'function') {
    throw new Error('isolate() needs module.registerHooks, from Node 22.15, to refuse original-fs');
  }
  // A resolve hook sees every require and every import, in any module, which no wrapper of
  // require or import() does.
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (isOriginalFs(specifier)) throw new Error('original-fs is disabled in tests');
      if (specifier === 'electron-updater') throw new Error('Updates are disabled in tests');
      return nextResolve(specifier, context);
    }
  });
  // getBuiltinModule loads a builtin without resolving it
  const getBuiltinModule = process.getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    process.getBuiltinModule = stubbed((id) => {
      if (isOriginalFs(id)) throw new Error('original-fs is disabled in tests');
      return getBuiltinModule.call(process, id);
    });
  }

  // import gives a builtin's named exports from a copy made when it was first imported, so
  // `import { writeFileSync } from 'fs'` would still be the function patched out above.
  Module.syncBuiltinESMExports();
}

module.exports = { hideWindows, isolate, stubbed, variables };
