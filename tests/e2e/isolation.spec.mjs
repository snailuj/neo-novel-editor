import { test, expect } from '@playwright/test';
import { launchProfile } from '../support/electron-profile.mjs';
import fsFunctions from '../support/fs-functions.cjs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths Electron can name that the app or Electron itself writes under. The harness sets
// each of them inside the profile, so a test never resolves one to the developer's own.
const PATH_NAMES = [
  'home', 'appData', 'userData', 'sessionData', 'temp', 'desktop', 'documents', 'downloads',
  'music', 'pictures', 'videos', 'logs', 'crashDumps',
];

// The variables that name a user's folders. Child processes and Chromium read these, not
// Electron's paths; the harness points them into the profile.
const VARIABLES = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
];

// The calls the app, or a later Electron, can make to the developer's system. The lists
// say which must exist on this platform, so a harness that stubs an empty object fails.
const SHELL = [
  'openExternal', 'openPath', 'showItemInFolder', 'trashItem', 'beep',
  ...(process.platform === 'win32' ? ['writeShortcutLink', 'readShortcutLink'] : []),
];
const DIALOG = [
  'showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync',
  'showMessageBox', 'showMessageBoxSync', 'showErrorBox',
  ...(process.platform === 'linux' ? [] : ['showCertificateTrustDialog']),
];

// Every way for the app to start a program.
const PROGRAMS = ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync'];

test('a test run is cut off from the developer\'s system', async () => {
  // A developer's shell can name plugin folders; their plugins must not load in a test.
  const named = process.env.NEO_PLUGIN_DIRS;
  process.env.NEO_PLUGIN_DIRS = 'scripts/fixtures/plugins';
  let fixture;
  try {
    fixture = await launchProfile();
  } finally {
    if (named === undefined) delete process.env.NEO_PLUGIN_DIRS;
    else process.env.NEO_PLUGIN_DIRS = named;
  }
  try {
    const outsideFile = path.join(tmpdir(), `neo-isolation-outside-${process.pid}.txt`);
    const seen = await fixture.app.evaluate(({ app, shell, dialog, systemPreferences, utilityProcess }, { names, variables, programs, calls, outsideFile, unguarded }) => {
      // The harness marks each stub; a call Electron implements has no mark.
      const unstubbed = (owner) => Object.entries(owner)
        .filter(([, fn]) => typeof fn === 'function' && fn.neoTestStub !== true)
        .map(([name]) => name);
      const state = (owner, list) => Object.fromEntries(list.map((name) => [name,
        typeof owner[name] !== 'function' ? 'missing' : owner[name].neoTestStub === true ? 'stub' : 'real']));
      // evaluate has no require; this is the same module object main.js gets.
      const childProcess = process.getBuiltinModule('node:child_process');
      const fs = process.getBuiltinModule('node:fs');
      const os = process.getBuiltinModule('node:os');
      const writeOutside = () => {
        try { fs.writeFileSync(outsideFile, 'x'); return 'written'; } catch (error) { return error.code; }
      };
      // Only a stub is asked to start something it should not.
      const forkRefused = () => {
        if (utilityProcess.fork.neoTestStub !== true) return 'not a stub';
        try { utilityProcess.fork('not-the-spell-worker.js'); return 'started'; } catch (error) { return error.message; }
      };
      // A function of fs that is neither guarded nor listed as safe is new, and has to be read.
      const unlistedFs = [];
      for (const [label, owner] of [['fs', fs], ['fs.promises', fs.promises]]) {
        for (const [name, fn] of Object.entries(owner)) {
          if (typeof fn === 'function' && fn.neoTestGuard !== true && !unguarded.includes(name)) unlistedFs.push(`${label}.${name}`);
        }
      }
      // original-fs is fs without the guard
      const originalFs = () => {
        try { return process.getBuiltinModule('original-fs') ? 'reached' : 'absent'; } catch (error) { return error.message; }
      };
      return {
        unlistedFs,
        originalFs: originalFs(),
        mkdtemp: ['mkdtemp', 'mkdtempSync', 'lchownSync', 'lutimesSync'].map((name) => [name, fs[name]?.neoTestGuard === true]),
        keychainSwitches: [app.commandLine.hasSwitch('use-mock-keychain'), app.commandLine.getSwitchValue('password-store')],
        forkRefused: forkRefused(),
        homedir: os.homedir(),
        tmpdir: os.tmpdir(),
        fetchStubbed: globalThis.fetch.neoTestStub === true,
        outsideWrite: writeOutside(),
        pluginDirs: process.env.NEO_PLUGIN_DIRS ?? null,
        neoVariables: Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('NEO_')).sort(),
        variables: Object.fromEntries(variables.map((name) => [name, process.env[name] ?? null])),
        paths: Object.fromEntries(names.map((name) => [name, app.getPath(name)])),
        unstubbedShell: unstubbed(shell),
        unstubbedDialog: unstubbed(dialog),
        shell: state(shell, calls.shell),
        dialog: state(dialog, calls.dialog),
        // macOS writes the app's defaults at every launch.
        setUserDefaultStubbed: systemPreferences.setUserDefault?.neoTestStub === true,
        programs: Object.fromEntries(programs.map((name) => [name, childProcess[name]?.neoTestStub === true])),
      };
    }, { names: PATH_NAMES, variables: VARIABLES, programs: PROGRAMS, calls: { shell: SHELL, dialog: DIALOG }, outsideFile, unguarded: fsFunctions.UNGUARDED });
    await rm(outsideFile, { force: true });

    expect.soft(seen.pluginDirs).toBeNull();
    expect.soft(seen.fetchStubbed).toBe(true);
    expect.soft(seen.unlistedFs).toEqual([]);
    expect.soft(seen.mkdtemp.filter(([, guarded]) => !guarded)).toEqual([]);
    expect.soft(seen.originalFs).toMatch(/disabled in tests/);
    // safeStorage reaches the Keychain (macOS) or the keyring (Linux) unless told not to; the
    // spell worker still starts (the baseline spec checks words), any other utility process does not
    expect.soft(seen.keychainSwitches).toEqual([true, 'basic']);
    expect.soft(seen.forkRefused).toMatch(/disabled in tests/);
    // the write guard: nothing outside the profile can be written
    expect.soft(seen.outsideWrite).toBe('TEST_WRITE_OUTSIDE_PROFILE');
    expect.soft(seen.neoVariables).toEqual(['NEO_TEST_PROFILE', 'NEO_TEST_VISIBLE']);
    const allStubs = (list) => Object.fromEntries(list.map((name) => [name, 'stub']));
    expect.soft(seen.shell).toEqual(allStubs(SHELL));
    expect.soft(seen.dialog).toEqual(allStubs(DIALOG));
    // and whatever else Electron has put on them since
    expect.soft(seen.unstubbedShell).toEqual([]);
    expect.soft(seen.unstubbedDialog).toEqual([]);
    expect.soft(seen.setUserDefaultStubbed).toBe(true);
    // email:draft runs osascript on macOS; nothing in a test starts a program.
    expect.soft(seen.programs).toEqual(Object.fromEntries(PROGRAMS.map((name) => [name, true])));
    const inProfile = (target) => {
      if (typeof target !== 'string') return false;
      const relative = path.relative(fixture.profile, target);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    // main.js starts its library at os.homedir() when it loads
    expect.soft([seen.homedir, seen.tmpdir].filter((target) => !inProfile(target))).toEqual([]);
    expect.soft(Object.entries(seen.paths).filter(([, target]) => !inProfile(target))).toEqual([]);
    expect.soft(Object.entries(seen.variables).filter(([, target]) => !inProfile(target))).toEqual([]);
  } finally { await fixture.close(); }
});

// The rule: every way main-process code can reach a function that writes a file gets the guarded
// function or a refusal. A plugin's main half is code of that kind, and so is anything it loads.
// Each route is tried for each specifier of fs and of Electron's original-fs (fs without the
// guard), with the write aimed outside the profile; nothing may be written. Two more modules
// lead to the same place: child_process (a program writes), worker_threads (a thread has an fs
// of its own, which no patch to this one reaches). The named imports matter: a facade of a
// builtin is a copy of its exports made at the first import, so patched functions are missed
// unless it is synced.
const ROUTES = ['require', 'import default', 'import named', 'getBuiltinModule'];
const SPECIFIERS = [
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'original-fs', 'original-fs/promises',
  'child_process', 'node:child_process', 'worker_threads', 'node:worker_threads',
];

test('no route to a function that writes a file leads round the guard', async () => {
  const fixture = await launchProfile();
  const outsideFile = path.join(tmpdir(), `neo-isolation-routes-${process.pid}.txt`);
  const leftovers = async () => (await readdir(tmpdir())).filter((name) => name.startsWith(path.basename(outsideFile)));
  try {
    // a clean baseline: a file left by an earlier run would read as a write by this one
    expect(await leftovers()).toEqual([]);
    const cases = ROUTES.flatMap((route) => SPECIFIERS.map((id) => [route, id]));
    // import() works only in a module the loader knows, so the routes run from a file of their own
    const outcomes = await fixture.app.evaluate(async (_electron, { helper, cases, outsideFile }) => {
      const load = process.getBuiltinModule('node:module').createRequire(helper);
      return load(helper).tryRoutes(cases, outsideFile);
    }, { helper: fileURLToPath(new URL('../support/fs-routes.cjs', import.meta.url)), cases, outsideFile });
    expect(outcomes).toEqual(Object.fromEntries(cases.map(([route, id]) => [`${route} ${id}`, 'refused'])));
  } finally {
    for (const name of await leftovers()) await rm(path.join(tmpdir(), name), { force: true });
    await fixture.close();
  }
});

// index.html's policy restricts scripts and objects only, so a chapter's image or a plugin's
// fetch in the window would reach a server but for the block in isolate().
test('a request the window makes to a server is cancelled before it leaves', async () => {
  const fixture = await launchProfile();
  try {
    const failures = [];
    fixture.page.on('requestfailed', (request) => failures.push([request.url(), request.failure()?.errorText]));
    const url = 'https://neo-test.invalid/cover.png';
    const outcome = await fixture.page.evaluate((src) => Promise.all([
      fetch(src).then(() => 'sent', () => 'failed'),
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve('loaded');
        image.onerror = () => resolve('failed');
        image.src = src;
      }),
    ]), url);
    expect(outcome).toEqual(['failed', 'failed']);
    // cancelled by the block, not by a name that would not resolve
    expect(failures.filter(([, why]) => why !== 'net::ERR_BLOCKED_BY_CLIENT')).toEqual([]);
    expect(failures.length).toBeGreaterThan(0);
  } finally { await fixture.close(); }
});

// A chosen library folder that is gone (an unplugged drive) makes main.js ask a synchronous
// dialog at launch. In a test that must be refused, not shown, and the app must carry on.
test('a missing library folder opens no dialog', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  let fixture;
  try {
    await mkdir(path.join(profile, 'userData'), { recursive: true });
    const unplugged = path.join(profile, 'unplugged', 'NEO Library');
    await writeFile(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ libraryDir: unplugged }));
    fixture = await launchProfile(profile);
    const library = path.join(profile, 'documents', 'NEO Library');
    expect(await fixture.page.evaluate(() => neo.libraryPath())).toBe(library);
    expect(await readFile(path.join(library, 'neo-errors.log'), 'utf8'))
      .toContain('dialog.showMessageBoxSync is disabled in tests');
  } finally {
    if (fixture) await fixture.close();
    else await rm(profile, { recursive: true, force: true });
  }
});

// book:delete sends a book folder to the system trash, which in a test is the profile's own.
// This calls shell.trashItem directly: book:delete itself first asks showMessageBox, and the
// stub answers 0 (Cancel), so a spec of book:delete must override it to answer 1.
test('trashing moves a folder into the profile and refuses one outside it', async () => {
  const fixture = await launchProfile();
  const outside = await mkdtemp(path.join(tmpdir(), 'neo-outside-'));
  try {
    const book = path.join(fixture.profile, 'documents', 'NEO Library', 'book-synthetic');
    await mkdir(book, { recursive: true });
    await writeFile(path.join(book, 'book.json'), '{}');

    const refusal = await fixture.app.evaluate(async ({ shell }, { book, outside }) => {
      await shell.trashItem(book);
      return shell.trashItem(outside).then(() => null, (error) => error.code);
    }, { book, outside });

    expect(refusal).toBe('TEST_WRITE_OUTSIDE_PROFILE');
    await expect(stat(book)).rejects.toThrow();
    const trashed = await readdir(path.join(fixture.profile, 'trash'));
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/book-synthetic$/);
    expect((await stat(outside)).isDirectory()).toBe(true);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await fixture.close();
  }
});
