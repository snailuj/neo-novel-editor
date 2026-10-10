const { app, BrowserWindow, dialog, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const os = require('node:os');
const { guardTestWrites } = require('./profile-boundary.cjs');
const { configureTestWindows } = require('./profile-windows.cjs');

const profile = process.env.NEO_TEST_PROFILE;
if (!profile || !path.isAbsolute(profile)) throw new Error('An absolute disposable profile is required');
os.homedir = () => profile;
os.tmpdir = () => path.join(profile, 'tmp');
guardTestWrites(fs, profile, event => console.warn(JSON.stringify(event)));
for (const name of ['userData', 'documents', 'exports', 'tmp', 'trash']) fs.mkdirSync(path.join(profile, name), { recursive: true });
app.setPath('userData', path.join(profile, 'userData'));
app.setPath('documents', path.join(profile, 'documents'));
app.setPath('temp', path.join(profile, 'tmp'));
// The rest of Electron's named folders, so none resolves to the developer's own: main.js
// falls back on `home` for a library, and a library there would be the real one. They are
// not created; sessionData, logs and crashDumps already follow userData.
app.setPath('home', profile);
for (const name of ['appData', 'desktop', 'downloads', 'music', 'pictures', 'videos']) {
  app.setPath(name, path.join(profile, name));
}
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
// A stub carries a mark, so that tests/e2e/isolation.spec.mjs can tell it from the real call.
const stubbed = (fn) => Object.assign(fn, { neoTestStub: true });
// Replaces every function of `owner` with one that throws. A call that answers at once must
// throw at once: a rejected promise in its place would read as an answer (a truthy one).
const refuse = (owner, label, answersAtOnce = () => false) => {
  for (const name of Object.keys(owner)) {
    const fail = () => { throw new Error(label + '.' + name + ' is disabled in tests'); };
    owner[name] = stubbed(answersAtOnce(name) ? fail : async () => fail());
  }
};
// Every dialog is refused first, the synchronous ones included: at launch main.js asks
// showMessageBoxSync and showOpenDialogSync when the chosen library folder is missing or
// unwritable, and catches the throw. The four answered since the harness began follow.
refuse(dialog, 'dialog', (name) => name.endsWith('Sync'));
dialog.showOpenDialog = stubbed(async () => ({ canceled: true, filePaths: [] }));
dialog.showSaveDialog = stubbed(async (_window, options) => ({ canceled: false, filePath: path.join(profile, 'exports', path.basename(options.defaultPath)) }));
dialog.showMessageBox = stubbed(async () => ({ response: 0 }));
dialog.showErrorBox = stubbed((_title, message) => { throw new Error(message); });
// The window never opens a browser, a file manager or a file, and writes no shortcut,
// during a test: every shell call is refused, whatever Electron adds, except trashItem.
// That moves the item into the profile's trash, so a test of book:delete can see the
// folder go there; the write guard refuses an item from outside the profile.
refuse(shell, 'shell');
shell.trashItem = stubbed(async (target) => {
  fs.renameSync(target, path.join(profile, 'trash', Date.now() + '-' + path.basename(target)));
});
globalThis.fetch = async () => { throw new Error('Network access is disabled in tests'); };
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'electron-updater') throw new Error('Updates are disabled in tests');
  return originalLoad.call(this, request, ...args);
};
// Only an expressly requested manual session shows a labelled synthetic window.
configureTestWindows(BrowserWindow, path.resolve(__dirname, '../..'), process.env.NEO_TEST_VISIBLE === '1');
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
  (_details, callback) => callback({ cancel: true }),
));
require('../../main.js');
