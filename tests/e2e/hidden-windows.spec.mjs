import { test, expect } from '@playwright/test';
import { _electron as electron } from '@playwright/test';
import { launchProfile } from '../support/electron-profile.mjs';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The rule: no window a test opens is ever visible on screen or holds the OS keyboard focus,
// however the code under test asks for it, so a run does not interrupt whoever is at the machine.
const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const electronPath = require('electron');
const isolation = require('../../scripts/isolate-test-app.js');

// What Windows says about a native window, which is the truth the owner sees; main's own
// isVisible and isFocused are Electron's account of it.
function osView() {
  if (process.platform !== 'win32') return null;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hwnd)');
  const GetForegroundWindow = user32.func('void *__stdcall GetForegroundWindow()');
  const handle = (hwnd) => koffi.address(hwnd);
  return {
    visible: (bytes) => IsWindowVisible(koffi.decode(bytes, 'void *')) !== 0,
    foreground: () => handle(GetForegroundWindow()),
    address: (bytes) => handle(koffi.decode(bytes, 'void *')),
  };
}

const NEVER_SHOWN = (events) => events.filter((entry) => ['show', 'focus', 'restore', 'maximize'].includes(entry.event));

async function launchProbe() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('NEO_')));
  Object.assign(env, { NEO_TEST_PROFILE: profile }, isolation.variables(profile));
  delete env.ELECTRON_RUN_AS_NODE;
  for (const dir of new Set(Object.values(isolation.variables(profile)))) await mkdir(dir, { recursive: true });
  const app = await electron.launch({ executablePath: electronPath, args: ['tests/support/window-probe.cjs'], cwd: appRoot, env });
  return { app, async close() { await app.close(); await rm(profile, { recursive: true, force: true }); } };
}

// The state of every open window, in main and as Windows has it.
async function windowStates(app) {
  const states = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => ({
    id: win.id, visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized(),
    handle: [...win.getNativeWindowHandle()],
  })));
  const os = osView();
  return states.map((state) => {
    const bytes = Buffer.from(state.handle);
    return { ...state, handle: undefined, osVisible: os ? os.visible(bytes) : null, address: os ? os.address(bytes) : null };
  });
}

test('a window that asks to be shown and focused stays hidden and unfocused', async () => {
  const probe = await launchProbe();
  try {
    await probe.app.evaluate(async ({ app, BrowserWindow }) => {
      const win = new BrowserWindow({ width: 600, height: 400, show: true });
      await win.loadURL('data:text/html,<input autofocus>');
      // every way for code to bring a window forward
      win.show(); win.showInactive(); win.focus(); win.moveTop(); win.restore(); win.maximize(); win.webContents.focus();
      app.focus({ steal: true });
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    const states = await windowStates(probe.app);
    // the window exists, so that the checks below look at something
    expect(states).toHaveLength(1);
    expect(states[0].visible).toBe(false);
    expect(states[0].focused).toBe(false);
    expect(await probe.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow())).toBeNull();
    const events = await probe.app.evaluate(() => globalThis.probeEvents);
    expect(events.some((entry) => entry.event === 'created')).toBe(true);
    expect(NEVER_SHOWN(events)).toEqual([]);
    const os = osView();
    if (os) {
      expect(states[0].osVisible).toBe(false);
      expect(os.foreground()).not.toBe(states[0].address);
    }
  } finally { await probe.close(); }
});

test('the app\'s own window in a test run is never shown or focused', async () => {
  const fixture = await launchProfile();
  try {
    const states = await windowStates(fixture.app);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.visible).toBe(false);
      expect(state.focused).toBe(false);
      if (state.osVisible !== null) expect(state.osVisible).toBe(false);
    }
    expect(await fixture.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow())).toBeNull();
    const events = await fixture.app.evaluate(() => globalThis.neoTestWindowEvents);
    // the record exists and saw the window made
    expect(events.some((entry) => entry.event === 'created')).toBe(true);
    expect(NEVER_SHOWN(events)).toEqual([]);
  } finally { await fixture.close(); }
});
