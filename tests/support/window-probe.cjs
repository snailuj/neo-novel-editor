// A bare isolated Electron main process for tests/e2e/hidden-windows.spec.mjs: it isolates, keeps
// its own record of every window event, and makes no window of its own. The spec creates windows
// in it and tries to bring them to the front.
const { app } = require('electron');
const path = require('node:path');
const { isolate } = require('../../scripts/isolate-test-app.js');

const profile = process.env.NEO_TEST_PROFILE;
if (!profile || !path.isAbsolute(profile)) throw new Error('An absolute disposable profile is required');
isolate(profile);
// The probe's own record, so the spec does not depend on the one isolate() keeps.
globalThis.probeEvents = [];
app.on('browser-window-created', (_event, win) => {
  globalThis.probeEvents.push({ id: win.id, event: 'created', visible: win.isVisible(), focused: win.isFocused() });
  for (const event of ['show', 'focus', 'restore', 'maximize']) {
    win.on(event, () => globalThis.probeEvents.push({ id: win.id, event }));
  }
});
// no window is open between the spec's calls, and the process stays up
app.on('window-all-closed', () => {});
