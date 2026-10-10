const { BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { isolate, stubbed } = require('../../scripts/isolate-test-app.js');
const { configureTestWindows } = require('./profile-windows.cjs');

const profile = process.env.NEO_TEST_PROFILE;
if (!profile || !path.isAbsolute(profile)) throw new Error('An absolute disposable profile is required');
// Everything that cuts the run off from the developer's machine is in the shared module, which
// scripts/plugins.e2e.js uses too. What follows answers a few calls instead of refusing them.
isolate(profile);
for (const name of ['exports', 'trash']) fs.mkdirSync(path.join(profile, name), { recursive: true });
dialog.showOpenDialog = stubbed(async () => ({ canceled: true, filePaths: [] }));
dialog.showSaveDialog = stubbed(async (_window, options) => ({ canceled: false, filePath: path.join(profile, 'exports', path.basename(options.defaultPath)) }));
dialog.showMessageBox = stubbed(async () => ({ response: 0 }));
dialog.showErrorBox = stubbed((_title, message) => { throw new Error(message); });
// shell.trashItem moves the item into the profile's trash; the write guard refuses an item from
// outside the profile. A spec of book:delete that watches the folder go there must first
// override dialog.showMessageBox to answer 1: the stub answers 0, which is Cancel there.
shell.trashItem = stubbed(async (target) => {
  fs.renameSync(target, path.join(profile, 'trash', Date.now() + '-' + path.basename(target)));
});
// Only an expressly requested manual session shows a labelled synthetic window.
configureTestWindows(BrowserWindow, path.resolve(__dirname, '../..'), process.env.NEO_TEST_VISIBLE === '1');
require('../../main.js');
