'use strict';

// Runs the real main.js in a vm against a library folder of the caller's choosing, with a
// stub of electron, and hands back its IPC handlers. This is the loader of
// scripts/power-loss.test.js, exported; upstream owns that file, so the two are kept in
// step by hand.
//
// loadMain() returns
//   call(name, ...args)  runs the ipcMain.handle handler `name` as the window would
//   pointAt(dir)         moves LIBRARY_DIR and LIBRARY_FILE to `dir`
//   context              the vm global, so a test can replace a main.js function
//                        (writeFileDurable, say) that its handlers look up by name
//   warnings             the messages main.js put in dialog.showMessageBox

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..', '..');
const localRequire = createRequire(path.join(root, 'main.js'));
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function loadMain() {
  const handlers = new Map();
  const warnings = [];
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: () => os.tmpdir(),
      getLocale: () => 'en',
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }),
      on() {}
    },
    ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items) => items, setApplicationMenu() {} },
    dialog: { showMessageBox: (opts) => { warnings.push(opts.message); return Promise.resolve({}); } },
    utilityProcess: { fork: () => ({ on() {}, postMessage() {} }) },
    screen: {}
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : localRequire(name),
    __dirname: root,
    process: { platform: process.platform, on() {} },
    console,
    libraryRoot: os.tmpdir()
  });
  vm.runInContext(source, context, { filename: path.join(root, 'main.js') });
  return {
    context,
    warnings,
    call: (name, ...args) => handlers.get(name)(null, ...args),
    pointAt(dir) {
      context.libraryRoot = dir;
      vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);
    }
  };
}

module.exports = { loadMain };
