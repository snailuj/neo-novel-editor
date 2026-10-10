import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, mock, test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const hasUnsafeEval = /new Function|\beval\(/;

function build(...args: string[]): string {
  return execFileSync(process.execPath, [path.join(root, 'tools', 'build.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [full];
  });
}

test('start builds first', () => {
  assert.equal(pkg.scripts.start, 'node tools/build.mjs && electron .');
  assert.equal(pkg.scripts['test:e2e'], 'npm run build && playwright test');
});

test('packaging builds first', () => {
  assert.equal(pkg.build.beforeBuild, 'tools/before-build.cjs');
  // electron-builder calls the hook from CI's bare `npx electron-builder`, so the
  // plugin must exist afterwards without any other step having run.
  const out = path.join(root, 'plugins', 'hoard');
  rmSync(out, { recursive: true, force: true });
  const hook = createRequire(import.meta.url)(path.join(root, pkg.build.beforeBuild));
  // electron-builder reads any falsy result as "node_modules is handled externally" and
  // skips the dependency rebuild, so the hook must return true.
  assert.equal(hook(), true);
  for (const file of ['renderer.js', 'main.cjs', 'plugin.json']) {
    assert.ok(existsSync(path.join(out, file)), `${file} is written`);
  }
});

test('clean build', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'hoard-build-'));
  try {
    const log = build('--out', out);
    for (const file of ['renderer.js', 'main.cjs', 'plugin.json']) {
      assert.ok(statSync(path.join(out, 'hoard', file)).size > 0, `${file} is written`);
    }
    const events = log.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((e) => e.name).sort(),
      ['main', 'manifest', 'renderer'],
    );
    for (const e of events) {
      assert.equal(e.event, 'build.target');
      assert.equal(typeof e.ms, 'number');
      assert.ok(e.bytes > 0);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CSP', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'hoard-build-'));
  try {
    build('--out', out);
    for (const file of ['renderer.js', 'main.cjs']) {
      const text = readFileSync(path.join(out, 'hoard', file), 'utf8');
      assert.doesNotMatch(text, hasUnsafeEval, `${file} avoids eval and new Function`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('packaging includes the output', () => {
  const files: string[] = pkg.build.files;
  assert.ok(files.includes('plugins/**'), 'plugins/** is kept');
  assert.ok(!files.includes('!plugins/**'));
  for (const dir of ['src', 'tools', 'tests', 'schemas']) {
    assert.ok(files.includes(`!${dir}/**`), `${dir}/** is excluded`);
  }
});

// afterPack is the net; these keep the files it would reject out of the package to begin with.
test('packaging leaves development files out', () => {
  const files: string[] = pkg.build.files;
  for (const pattern of [
    'docs/**',
    '.superpowers/**',
    'test-results/**',
    'tsconfig*.json',
    'playwright.config.*',
    '.oxlintrc.json',
    'print/README.md',
  ]) {
    assert.ok(files.includes(`!${pattern}`), `${pattern} is excluded`);
  }
});

test('packaging checks the package', () => {
  assert.equal(pkg.build.afterPack, 'tools/after-pack.cjs');
  assert.ok(existsSync(path.join(root, pkg.build.afterPack)), 'the hook exists');
  // The hook calls @electron/asar itself, so it is pinned here rather than left to
  // arrive through app-builder-lib, which could drop it on any update.
  assert.equal(pkg.devDependencies['@electron/asar'], '3.4.1');
});

test('no direct bridge calls', () => {
  for (const file of sourceFiles(path.join(root, 'src'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /window\.neo\./, file);
  }
});

type Stray = { path: string; reason: string };

// The tracked list git would give for this repo, cut down to what the cases need.
const TRACKED = [
  'package.json',
  'main.js',
  'locales/fr.json',
  'fonts/a.woff2',
  'README.md',
  'docs/plans/x.md',
  'tsconfig.json',
  'tsconfig.build.json',
  'playwright.config.mjs',
  '.oxlintrc.json',
];
const CLEAN = [
  'package.json',
  'main.js',
  'locales/fr.json',
  'fonts/a.woff2',
  'plugins/hoard/plugin.json',
  'plugins/hoard/renderer.js',
  'plugins/hoard/main.cjs',
  'node_modules/foo/README.md',
  'node_modules/foo/index.js',
];

function strays(packaged: string[], tracked: string[] = TRACKED): Stray[] {
  const { findStrays } = createRequire(import.meta.url)(path.join(root, 'tools', 'stray-files.cjs')) as {
    findStrays(packaged: string[], tracked: string[]): Stray[];
  };
  return findStrays(packaged, tracked);
}

// The file is the only stray in an otherwise clean package, with a reason of the given kind.
function assertStray(file: string, reason: RegExp, tracked: string[] = TRACKED): void {
  const found = strays([...CLEAN, file], tracked);
  assert.deepEqual(found.map((s) => s.path), [file]);
  assert.match(found[0].reason, reason);
}

test('a clean package has no strays', () => {
  assert.deepEqual(strays(CLEAN), []);
});

test('a packaged file outside node_modules and plugins must be tracked', () => {
  assertStray('stray.txt', /not tracked/);
  assertStray('test-results/.last-run.json', /not tracked/);
});

test('paths are compared as git writes them', () => {
  assert.deepEqual(strays(['fonts\\a.woff2', './main.js', '/package.json']), []);
});

test('tracked development files are strays too', () => {
  assertStray('docs/plans/x.md', /development.*docs/);
  assertStray('tsconfig.json', /development.*tsconfig/);
  assertStray('tsconfig.build.json', /development.*tsconfig/);
  assertStray('playwright.config.mjs', /development.*playwright/);
  assertStray('.oxlintrc.json', /development.*oxlint/);
  assertStray('README.md', /development.*\.md/);
});

test('dependencies keep their own docs and configs', () => {
  assert.deepEqual(
    strays(['node_modules/foo/README.md', 'node_modules/foo/docs/a.md', 'node_modules/foo/tsconfig.json']),
    [],
  );
});

test('a plugin ships its manifest and its code, nothing else', () => {
  assertStray('plugins/hoard/notes.md', /plugin/);
  assertStray('plugins/hoard/renderer.js.map', /plugin/);
  assertStray('plugins/hoard/data.json', /plugin/);
  assertStray('plugins/hoard/sub/plugin.json', /plugin/);
  // code belongs to a plugin folder, not to plugins/ itself
  assertStray('plugins/stray.js', /plugin/);
  assertStray('plugins/stray.css', /plugin/);
  assert.deepEqual(
    strays(['plugins/a/plugin.json', 'plugins/a/main.cjs', 'plugins/a/m.mjs', 'plugins/a/ui/style.css', 'plugins/a/ui/r.js']),
    [],
  );
});

test('names and folders that mark writing are strays, tracked or not', () => {
  for (const file of [
    '.superpowers/x',
    'book-x/book.json',
    'fonts/deep/library.json',
    'chapters/ch-1.html',
    '.obsidian/app.json',
    '_meta/x.md',
    'node_modules/foo/book.json',
    'plugins/hoard/.obsidian/app.json',
    'plugins/hoard/book.json',
  ]) {
    assertStray(file, /writing/);
    assertStray(file, /writing/, [...TRACKED, file]);
  }
});

test('every file and folder of a library or vault is a marker', () => {
  for (const file of [
    'library.json.tmp',
    'library.json.bak',
    'book.json.bak',
    'darlings.json',
    'stickies.json',
    'art.json',
    'snapshots/20261010T120000Z-d-3-900-ab12/snapshot.json',
    'notes.html',
    'outline.html',
    '_catalog.txt',
    'neo-errors.log',
    'Backups/neo-backup-2026-10-10.zip',
    'neo-backup-2026-10-10.zip',
    'Exports/draft.pdf',
    'Deleted Books/book-x-lxyz1234-abcde/book.json',
    'book-my-novel-lxyz1234-abcde/anything.txt',
    'book-lxyz1234-abcde/anything.txt',
    'book-x/cover-1700000000000.png',
    'cover-1700000000000.jpg',
    'art-1700000000000.webp',
    'something/chapters/intro.html',
    'x/ch-lxyz1234-ab12.html',
    '.neo/provenance.json',
  ]) {
    assertStray(file, /writing/, [...TRACKED, file]);
  }
});

test('markers are narrow enough for the packages NEO depends on', () => {
  assert.deepEqual(
    strays([
      'node_modules/foo/exports/index.js',
      'node_modules/foo/backups/index.js',
      'node_modules/book-cover/index.js',
      'node_modules/foo/cover-art.png',
      'node_modules/foo/art-deco.css',
      'node_modules/foo/notes.txt',
      'node_modules/foo/chapters.js',
      'node_modules/foo/snapshots/index.js',
      'node_modules/foo/library.js',
    ]),
    [],
  );
});

type PackContext = {
  appOutDir: string;
  electronPlatformName: string;
  packager: { projectDir: string; appInfo: { productFilename: string } };
};
type FakePackage = { context: PackContext; project: string; resources: string; unpacked: string };

const TRACKED_FILES = ['package.json', 'main.js', 'locales/fr.json', 'node_modules/dictionary-ro/index.js'];
const UNTRACKED_FILES = ['node_modules/foo/README.md', 'plugins/hoard/plugin.json', 'plugins/hoard/renderer.js'];

function put(dir: string, file: string, text = '{}'): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

// A project under git and a package packed from it the way electron-builder lays one out:
// app.asar next to app.asar.unpacked, which holds node_modules/dictionary-ro.
async function fakePackage(
  platform: string,
  options: { git?: boolean; extra?: string[]; asar?: boolean; unpack?: boolean } = {},
): Promise<FakePackage> {
  const base = mkdtempSync(path.join(tmpdir(), 'hoard-pack-'));
  fakePackages.push(base);
  const project = path.join(base, 'project');
  const app = path.join(base, 'app');
  for (const file of TRACKED_FILES) put(project, file);
  if (options.git !== false) {
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['add', '-A'], { cwd: project });
  }
  for (const file of [...TRACKED_FILES, ...UNTRACKED_FILES, ...(options.extra ?? [])]) put(app, file);
  const appOutDir = path.join(base, 'out');
  const resources = platform === 'darwin'
    ? path.join(appOutDir, 'NEO.app', 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  mkdirSync(resources, { recursive: true });
  if (options.asar !== false) {
    await asarApi().createPackageWithOptions(
      app,
      path.join(resources, 'app.asar'),
      options.unpack === false ? {} : { unpackDir: 'node_modules/dictionary-ro' },
    );
  }
  const context = {
    appOutDir,
    electronPlatformName: platform,
    packager: { projectDir: project, appInfo: { productFilename: 'NEO' } },
  };
  return { context, project, resources, unpacked: path.join(resources, 'app.asar.unpacked') };
}

const fakePackages: string[] = [];
const asarApi = () => createRequire(import.meta.url)('@electron/asar') as typeof import('@electron/asar');
const afterPack = (context: PackContext): Promise<void> =>
  (createRequire(import.meta.url)(path.join(root, 'tools', 'after-pack.cjs')) as (c: PackContext) => Promise<void>)(context);

// The hook's one log line, parsed.
async function checked(context: PackContext): Promise<Record<string, unknown>> {
  const log = mock.method(console, 'log', () => {});
  try {
    await afterPack(context);
    assert.equal(log.mock.callCount(), 1, 'one line is logged');
    return JSON.parse(log.mock.calls[0].arguments[0]);
  } finally {
    log.mock.restore();
  }
}

afterEach(() => {
  for (const dir of fakePackages.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('afterPack passes a clean package and logs what it checked', async () => {
  const line = await checked((await fakePackage('win32')).context);
  assert.equal(line.event, 'pack.check');
  assert.equal(line.checked, TRACKED_FILES.length + UNTRACKED_FILES.length);
  assert.equal(line.unpacked, 1);
  assert.equal(typeof line.ms, 'number');
});

test('afterPack reads the asar under the .app on macOS', async () => {
  const line = await checked((await fakePackage('darwin')).context);
  assert.equal(line.checked, TRACKED_FILES.length + UNTRACKED_FILES.length);
});

test('afterPack names every stray in app.asar with its reason', async () => {
  const { context } = await fakePackage('win32', { extra: ['book-planted/book.json', 'stray.txt'] });
  await assert.rejects(afterPack(context), (err: Error) => {
    assert.match(err.message, /book-planted\/book\.json.*writing marker/);
    assert.match(err.message, /stray\.txt.*not tracked/);
    return true;
  });
});

test('afterPack walks app.asar.unpacked too', async () => {
  const { context, unpacked } = await fakePackage('win32');
  put(unpacked, 'loose/stray.txt');
  put(unpacked, 'node_modules/dictionary-ro/book.json');
  await assert.rejects(afterPack(context), (err: Error) => {
    assert.match(err.message, /loose\/stray\.txt.*not tracked/);
    assert.match(err.message, /node_modules\/dictionary-ro\/book\.json.*writing marker/);
    return true;
  });
});

test('afterPack does not follow a link out of the package', async () => {
  const { context, unpacked } = await fakePackage('win32');
  const outside = path.join(context.appOutDir, '..', 'outside');
  put(outside, 'chapters/ch-1.html');
  symlinkSync(outside, path.join(unpacked, 'node_modules', 'linked'), 'junction');
  await assert.rejects(afterPack(context), (err: Error) => {
    assert.match(err.message, /node_modules\/linked.*outside the package/);
    assert.doesNotMatch(err.message, /ch-1\.html/);
    return true;
  });
});

test('afterPack takes a missing app.asar.unpacked as nothing unpacked', async () => {
  const line = await checked((await fakePackage('win32', { unpack: false })).context);
  assert.equal(line.unpacked, 0);
});

test('afterPack fails on an app.asar.unpacked it cannot stat, rather than treating it as absent', async () => {
  const { context } = await fakePackage('win32');
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const lstat = fs.lstatSync;
  const denied = mock.method(fs, 'lstatSync', ((file: string, ...rest: unknown[]) => {
    if (file.endsWith('app.asar.unpacked')) {
      throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${file}'`), { code: 'EPERM' });
    }
    return (lstat as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.lstatSync);
  try {
    await assert.rejects(afterPack(context), /EPERM.*app\.asar\.unpacked/);
  } finally {
    denied.mock.restore();
  }
});

test('afterPack fails when it cannot check', async () => {
  await assert.rejects(afterPack((await fakePackage('win32', { asar: false })).context), /app\.asar/);
  await assert.rejects(afterPack((await fakePackage('win32', { git: false })).context), /git/);
  const { context, resources } = await fakePackage('win32');
  writeFileSync(path.join(resources, 'app.asar'), 'not an archive');
  await assert.rejects(afterPack(context), /app\.asar/);
});
