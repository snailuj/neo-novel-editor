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

const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

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
    const fail = () => { throw new Error(label + '.' + name + ' is disabled in tests'); };
    owner[name] = stubbed(answersAtOnce(name) ? fail : async () => fail());
  }
}

// Makes every fs function that writes, links or moves refuse a path outside `profile`.
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

// `profile` is the run's temp folder: everything the run does stays inside it. `userData` and
// `documents` are where NEO keeps its settings and its default library, inside it by default.
function isolate(profile, {
  userData = path.join(profile, 'userData'),
  documents = path.join(profile, 'documents')
} = {}) {
  const { app, dialog, session, shell, systemPreferences, utilityProcess } = require('electron');
  const env = variables(profile);

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
  // Electron's original-fs is fs without the guard above, which a plugin's main half could
  // require: by require, which every one goes through Module._load for, or by getBuiltinModule.
  const refuseOriginalFs = (id) => {
    if (/^(node:)?original-fs(\/|$)/.test(String(id))) throw new Error('original-fs is disabled in tests');
  };
  const load = Module._load;
  Module._load = function (request, ...args) {
    if (request === 'electron-updater') throw new Error('Updates are disabled in tests');
    refuseOriginalFs(request);
    return load.call(this, request, ...args);
  };
  const getBuiltinModule = process.getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    process.getBuiltinModule = stubbed((id) => {
      refuseOriginalFs(id);
      return getBuiltinModule.call(process, id);
    });
  }
}

module.exports = { isolate, stubbed, variables };
