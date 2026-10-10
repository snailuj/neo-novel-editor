import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const root = fileURLToPath(new URL('../..', import.meta.url));
const localRequire = createRequire(path.join(root, 'scripts', 'plugins.e2e.js'));

// What Electron has today. A script that refuses `Object.keys` of these refuses what a later
// Electron adds as well; the lists keep this test from passing on an empty object.
const DIALOG = [
  'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync',
  'showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showCertificateTrustDialog',
];
const SHELL = [
  'showItemInFolder', 'openPath', 'openExternal', 'trashItem', 'beep', 'writeShortcutLink', 'readShortcutLink',
];

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Runs a script's setup, everything before it requires main.js, against stand-ins for
// Electron. The script's temp folder is made in a sandbox of ours, so nothing here touches the
// real one.
function setup(script: string) {
  const source = readFileSync(path.join(root, 'scripts', script), 'utf8');
  const entry = /^require\('\.\.\/main\.js'\);?$/m.exec(source);
  assert.ok(entry, `${script} requires main.js on a line of its own`);

  const sandbox = mkdtempSync(path.join(tmpdir(), 'hoard-script-'));
  sandboxes.push(sandbox);
  const paths = new Map<string, string>();
  const refused = () => 'a real call';
  const dialog = Object.fromEntries(DIALOG.map((name) => [name, refused]));
  const shell = Object.fromEntries(SHELL.map((name) => [name, refused]));
  const electron = {
    app: { setPath: (name: string, to: string) => paths.set(name, to), commandLine: { appendSwitch() {} }, on() {} },
    BrowserWindow: { prototype: { loadFile() {} } },
    Menu: {},
    dialog,
    shell,
  };
  const context = createContext({
    require: (name: string) => {
      if (name === 'electron') return electron;
      if (name === 'os') return { ...os, tmpdir: () => sandbox };
      return localRequire(name);
    },
    process: { pid: process.pid, env: {}, kill: process.kill },
    __dirname: path.join(root, 'scripts'),
    console,
  });
  runInContext(source.slice(0, entry.index), context, { filename: script });
  return { sandbox, paths, dialog, shell };
}

for (const script of ['plugins.e2e.js', 'plugin-edits.e2e.js']) {
  test(`${script} moves every folder Electron names into its temp folder`, () => {
    const { sandbox, paths } = setup(script);
    for (const name of ['userData', 'documents', 'home', 'appData']) {
      const target = paths.get(name);
      assert.ok(target, `${name} is set`);
      assert.ok(!path.relative(sandbox, target).startsWith('..'), `${name} is inside the temp folder`);
    }
  });

  test(`${script} refuses every dialog and shell call`, () => {
    const { dialog, shell } = setup(script);
    for (const [owner, label] of [[dialog, 'dialog'], [shell, 'shell']] as const) {
      for (const [name, call] of Object.entries(owner)) {
        // At once, not as a rejected promise: a synchronous dialog's answer is its return value.
        assert.throws(call as () => unknown, /disabled in tests/, `${label}.${name} throws`);
      }
    }
  });
}
