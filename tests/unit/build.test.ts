import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, mock, test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const hasUnsafeEval = /new Function|\beval\(/;

const sandboxes: string[] = [];

// The sources a build reads, copied into a temporary root. A test builds there and never in
// the repository, whose src/generated and plugins/hoard it must not rewrite or delete.
function sandbox(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hoard-build-'));
  sandboxes.push(dir);
  for (const name of ['schemas', 'src']) cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  copyFileSync(path.join(root, 'tsconfig.json'), path.join(dir, 'tsconfig.json'));
  // The generated validators load Ajv's runtime helpers, and nothing above a temporary
  // root holds a node_modules. A link to the repository's would reach back into it.
  const runtime = path.join('node_modules', 'ajv', 'dist', 'runtime');
  cpSync(path.join(root, runtime), path.join(dir, runtime), { recursive: true });
  return dir;
}

// The root comes first so that no call can leave it out.
function build(dir: string, ...args: string[]): string {
  return execFileSync(process.execPath, [path.join(root, 'tools', 'build.mjs'), '--root', dir, ...args], {
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

// Every file under the repository's src/generated and plugins/hoard, with its size and
// modification time, so that a write to any of them shows.
function repositoryOutputs(): string[] {
  return ['src/generated', 'plugins/hoard'].flatMap((dir) => {
    const full = path.join(root, dir);
    return existsSync(full)
      ? sourceFiles(full).map((file) => `${path.relative(root, file)}:${statSync(file).size}:${statSync(file).mtimeMs}`)
      : [];
  }).sort();
}

test('start builds first', () => {
  assert.equal(pkg.scripts.start, 'node tools/build.mjs && electron .');
  assert.equal(pkg.scripts['test:e2e'], 'npm run build && playwright test');
});

test('packaging builds first', () => {
  assert.equal(pkg.build.beforeBuild, 'tools/before-build.cjs');
  // electron-builder calls the hook from CI's bare `npx electron-builder`, so the
  // plugin must exist afterwards without any other step having run. The hook runs the
  // repository's build.mjs; the test points that build at a temporary root.
  const dir = sandbox();
  const calls: string[][] = [];
  const require = createRequire(import.meta.url);
  const hookFile = require.resolve(path.join(root, pkg.build.beforeBuild));
  // The hook binds execFileSync when it is loaded, so the mock goes in first.
  mock.method(childProcess, 'execFileSync', ((file: string, args: string[], options: object) => {
    calls.push([file, ...args]);
    return execFileSync(file, [...args, '--root', dir], { ...options, stdio: 'pipe' });
  }) as never);
  try {
    delete require.cache[hookFile];
    const hook = require(hookFile);
    // electron-builder reads any falsy result as "node_modules is handled externally" and
    // skips the dependency rebuild, so the hook must return true.
    assert.equal(hook(), true);
  } finally {
    mock.restoreAll();
    delete require.cache[hookFile];
  }
  assert.deepEqual(calls, [[process.execPath, path.join(root, 'tools', 'build.mjs')]]);
  for (const file of ['renderer.js', 'main.cjs', 'plugin.json']) {
    assert.ok(existsSync(path.join(dir, 'plugins', 'hoard', file)), `${file} is written`);
  }
});

test('clean build', () => {
  const dir = sandbox();
  const log = build(dir);
  for (const file of ['renderer.js', 'main.cjs', 'plugin.json']) {
    assert.ok(statSync(path.join(dir, 'plugins', 'hoard', file)).size > 0, `${file} is written`);
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
});

test('CSP', () => {
  const dir = sandbox();
  const out = path.join(dir, 'elsewhere');
  build(dir, '--out', out);
  for (const file of ['renderer.js', 'main.cjs']) {
    const text = readFileSync(path.join(out, 'hoard', file), 'utf8');
    assert.doesNotMatch(text, hasUnsafeEval, `${file} avoids eval and new Function`);
  }
});

test('a build in another root reads and writes that root only', () => {
  const dir = sandbox();
  // A schema changed with no `npm run gen`: the build regenerates, in its own root.
  const schemaFile = path.join(dir, 'schemas', 'plugin-manifest-v1.json');
  const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
  schema.properties.homepage = { type: 'string' };
  writeFileSync(schemaFile, JSON.stringify(schema, null, 2) + '\n');
  const before = repositoryOutputs();

  build(dir);

  assert.match(readFileSync(path.join(dir, 'src', 'generated', 'plugin-manifest-v1.d.ts'), 'utf8'), /homepage/);
  assert.ok(existsSync(path.join(dir, 'plugins', 'hoard', 'main.cjs')), 'the output is under the root');
  assert.deepEqual(repositoryOutputs(), before, 'src/generated and plugins/hoard are as they were');
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
  packager: {
    projectDir: string;
    appInfo: { productFilename: string };
    config?: Record<string, unknown>;
    platformSpecificBuildOptions?: Record<string, unknown>;
  };
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
  options: {
    git?: boolean;
    extra?: string[];
    asar?: boolean;
    unpack?: boolean;
    // more tracked files in the project, with their text
    files?: Record<string, string>;
    // electron-builder's build config and the running platform's own section of it
    config?: Record<string, unknown>;
    platformOptions?: Record<string, unknown>;
  } = {},
): Promise<FakePackage> {
  const base = mkdtempSync(path.join(tmpdir(), 'hoard-pack-'));
  fakePackages.push(base);
  const project = path.join(base, 'project');
  const app = path.join(base, 'app');
  for (const file of TRACKED_FILES) put(project, file);
  for (const [file, text] of Object.entries(options.files ?? {})) put(project, file, text);
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
    packager: {
      projectDir: project,
      appInfo: { productFilename: 'NEO' },
      config: options.config ?? {},
      platformSpecificBuildOptions: options.platformOptions ?? {},
    },
  };
  return { context, project, resources, unpacked: path.join(resources, 'app.asar.unpacked') };
}

// An archive that is only a header, to hold link entries @electron/asar itself would refuse
// to pack. Layout: a pickle with the header's size, then a pickle with the header's JSON.
function writeHeaderOnlyAsar(file: string, files: object): void {
  const json = Buffer.from(JSON.stringify({ files }));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  writeFileSync(file, Buffer.concat([size, header]));
}

// A package whose app.asar holds package.json and node_modules/linked, a link to `target`.
async function packageWithAsarLink(target: string): Promise<PackContext> {
  const { context, resources } = await fakePackage('win32', { asar: false });
  writeHeaderOnlyAsar(path.join(resources, 'app.asar'), {
    'package.json': { size: 2, offset: '0' },
    node_modules: { files: { linked: { link: target } } },
  });
  return context;
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
  for (const dir of [...fakePackages.splice(0), ...sandboxes.splice(0)]) rmSync(dir, { recursive: true, force: true });
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

test('afterPack reports a link that does not resolve', async () => {
  const { context, unpacked } = await fakePackage('win32');
  const gone = path.join(context.appOutDir, '..', 'gone');
  mkdirSync(gone);
  symlinkSync(gone, path.join(unpacked, 'node_modules', 'dangling'), 'junction');
  rmSync(gone, { recursive: true });
  await assert.rejects(afterPack(context), /node_modules\/dangling.*does not resolve/);
});

test('afterPack allows a link inside app.asar that stays inside it', async () => {
  const line = await checked(await packageWithAsarLink('node_modules/dictionary-ro'));
  assert.equal(line.checked, 2);
});

test('afterPack reports a link inside app.asar that leaves it', async () => {
  await assert.rejects(afterPack(await packageWithAsarLink('../outside')), /node_modules\/linked.*outside the package/);
});

// @electron/asar writes link targets with the OS separator, and a different version may
// pack an absolute one; either leaves the archive.
test('afterPack reads link targets with backslashes and absolute targets', async () => {
  for (const target of [
    '..\\outside',
    'node_modules\\..\\..\\outside',
    'C:\\vault\\hoard',
    'C:/vault/hoard',
    '/vault/hoard',
    '\\\\server\\share',
  ]) {
    await assert.rejects(
      afterPack(await packageWithAsarLink(target)),
      /node_modules\/linked.*outside the package/,
      target,
    );
  }
  const line = await checked(await packageWithAsarLink('node_modules\\dictionary-ro'));
  assert.equal(line.checked, 2);
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

// Files can reach the package without passing app.asar's tracked-file rule. The project's
// node_modules can hold a link to a folder of the project (dictionary-hu is
// `file:dictionaries/hu`), and electron-builder reads through it and unpacks the contents as
// plain files. extraResources copy a folder as it is. An untracked file in either source
// ships, so the hook checks the sources, not only the result.
const CHAPTER = 'Chapter 3.txt';
const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/dictionary-hu': { resolved: 'dictionaries/hu', link: true },
    'dictionaries/hu': { version: '1.0.0' },
  },
});
const HUNSPELL = { extraResources: [{ from: 'licenses/hunspell', to: 'licenses/hunspell' }] };

function linkPackage(project: string, name: string, target: string): void {
  mkdirSync(path.dirname(path.join(project, 'node_modules', name)), { recursive: true });
  symlinkSync(target, path.join(project, 'node_modules', name), 'junction');
}

test('findMarked applies the writing markers alone', () => {
  const { findMarked } = createRequire(import.meta.url)(path.join(root, 'tools', 'stray-files.cjs')) as {
    findMarked(packaged: string[]): Stray[];
  };
  const found = findMarked(['licenses/hunspell/book.json', 'app-update.yml', 'licenses/COPYING', 'tsconfig.json']);
  assert.deepEqual(found.map((s) => s.path), ['licenses/hunspell/book.json']);
  assert.match(found[0].reason, /writing/);
});

test('afterPack refuses an untracked file in a package the project links to', async () => {
  const { context, project, unpacked } = await fakePackage('win32', {
    files: { 'package-lock.json': LOCK, 'dictionaries/hu/index.dic': 'dic' },
  });
  linkPackage(project, 'dictionary-hu', path.join(project, 'dictionaries', 'hu'));
  put(project, `dictionaries/hu/${CHAPTER}`, 'words');
  // what electron-builder does through the link
  put(unpacked, 'node_modules/dictionary-hu/index.dic');
  put(unpacked, `node_modules/dictionary-hu/${CHAPTER}`, 'words');
  await assert.rejects(afterPack(context), (err: Error) => {
    assert.match(err.message, /dictionaries\/hu\/Chapter 3\.txt: untracked file/);
    assert.match(err.message, /1 stray file/, 'the lock file and node_modules name one folder, reported once');
    return true;
  });
});

test('afterPack passes a linked package whose folder is all tracked', async () => {
  const { context, project, unpacked } = await fakePackage('win32', {
    files: { 'package-lock.json': LOCK, 'dictionaries/hu/index.dic': 'dic' },
  });
  linkPackage(project, 'dictionary-hu', path.join(project, 'dictionaries', 'hu'));
  put(unpacked, 'node_modules/dictionary-hu/index.dic');
  await checked(context);
});

test('afterPack checks a link the lock file names when node_modules has none', async () => {
  const { context, project } = await fakePackage('win32', {
    files: { 'package-lock.json': LOCK, 'dictionaries/hu/index.dic': 'dic' },
  });
  put(project, `dictionaries/hu/${CHAPTER}`);
  await assert.rejects(afterPack(context), /dictionaries\/hu\/Chapter 3\.txt: untracked file/);
});

test('afterPack checks a link in node_modules that no lock file names', async () => {
  const { context, project } = await fakePackage('win32', { files: { 'dictionaries/hu/index.dic': 'dic' } });
  linkPackage(project, 'dictionary-hu', path.join(project, 'dictionaries', 'hu'));
  put(project, `dictionaries/hu/${CHAPTER}`);
  await assert.rejects(afterPack(context), /dictionaries\/hu\/Chapter 3\.txt: untracked file/);
});

test('afterPack counts a git-ignored file in a source folder as untracked', async () => {
  const { context, project } = await fakePackage('win32', {
    files: { '.gitignore': '*.secret\n', 'package-lock.json': LOCK, 'dictionaries/hu/index.dic': 'dic' },
  });
  put(project, 'dictionaries/hu/draft.secret');
  await assert.rejects(afterPack(context), /dictionaries\/hu\/draft\.secret: untracked file/);
});

test('afterPack refuses a package in node_modules that resolves outside the project', async () => {
  for (const name of ['linked', '@neo/linked']) {
    const { context, project } = await fakePackage('win32');
    const vault = path.join(context.appOutDir, '..', 'vault');
    put(vault, 'book.json');
    linkPackage(project, name, vault);
    await assert.rejects(afterPack(context), (err: Error) => {
      assert.match(err.message, new RegExp(`node_modules/${name}: .*outside the project`));
      assert.doesNotMatch(err.message, /book\.json/, 'the link is not followed');
      return true;
    });
  }
});

test('afterPack refuses a node_modules that itself resolves outside the project', async () => {
  const { context, project } = await fakePackage('win32');
  const elsewhere = path.join(context.appOutDir, '..', 'elsewhere');
  mkdirSync(elsewhere);
  rmSync(path.join(project, 'node_modules'), { recursive: true });
  symlinkSync(elsewhere, path.join(project, 'node_modules'), 'junction');
  await assert.rejects(afterPack(context), /node_modules: .*outside the project/);
});

test('afterPack checks every extraResources source for untracked files', async () => {
  const sections = {
    'a from and to': { config: HUNSPELL },
    'a plain string': { config: { extraResources: ['licenses/hunspell'] } },
    'one entry, not a list': { config: { extraResources: HUNSPELL.extraResources[0] } },
    'extraFiles': { config: { extraFiles: HUNSPELL.extraResources } },
    "the platform's own section": { platformOptions: HUNSPELL },
  };
  for (const [name, section] of Object.entries(sections)) {
    const { context, project, resources } = await fakePackage('win32', {
      files: { 'licenses/hunspell/COPYING': 'mpl' },
      ...section,
    });
    put(project, `licenses/hunspell/${CHAPTER}`);
    put(resources, 'licenses/hunspell/COPYING');
    put(resources, `licenses/hunspell/${CHAPTER}`);
    await assert.rejects(afterPack(context), /licenses\/hunspell\/Chapter 3\.txt: untracked file/, name);
  }
});

test('afterPack checks an extraResources source that lands in app.asar.unpacked', async () => {
  const { context, project, unpacked } = await fakePackage('win32', {
    files: { 'licenses/dictionary-sv/index.aff': 'aff' },
    config: {
      extraResources: [{ from: 'licenses/dictionary-sv', to: 'app.asar.unpacked/node_modules/dictionary-sv' }],
    },
  });
  put(project, `licenses/dictionary-sv/${CHAPTER}`);
  put(unpacked, 'node_modules/dictionary-sv/index.aff');
  put(unpacked, `node_modules/dictionary-sv/${CHAPTER}`);
  await assert.rejects(afterPack(context), /licenses\/dictionary-sv\/Chapter 3\.txt: untracked file/);
});

test('afterPack refuses an extraResources source it cannot place in the project', async () => {
  for (const [from, message] of [
    ['../outside', /\.\.\/outside: .*outside the project/],
    // an electron-builder macro, written so it is not read as a template string
    [`licenses/\${arch}`, /cannot check .*\$\{arch\}/],
  ] as const) {
    const { context } = await fakePackage('win32', { config: { extraResources: [{ from, to: 'x' }] } });
    await assert.rejects(afterPack(context), message);
  }
});

// electron-builder is a caret range: a renamed field must stop the build, not turn the
// extraResources check off.
test('afterPack refuses to run when the build config is not there to read', async () => {
  for (const field of ['config', 'platformSpecificBuildOptions'] as const) {
    for (const missing of [undefined, null, 'extraResources']) {
      const { context } = await fakePackage('win32');
      (context.packager as Record<string, unknown>)[field] = missing;
      await assert.rejects(afterPack(context), new RegExp(`cannot check.*packager\\.${field}`), `${field} ${missing}`);
    }
  }
});

// electron-builder copies what a link inside a dependency points at as plain files, so the
// package shows no link. The hook walks the project's own node_modules for every packed path.
const JSZIP = ['node_modules/jszip/index.js', 'node_modules/jszip/notes/page.txt'];

async function packageWithNestedLink(
  target: (context: PackContext, project: string) => string,
  options: { files?: Record<string, string>; extra?: string[] } = {},
): Promise<FakePackage> {
  const made = await fakePackage('win32', {
    files: { 'node_modules/jszip/index.js': '', ...options.files },
    extra: options.extra ?? JSZIP,
  });
  linkPackage(made.project, 'jszip/notes', target(made.context, made.project));
  return made;
}

const outsideProject = (context: PackContext): string => {
  const vault = path.join(context.appOutDir, '..', 'vault');
  put(vault, 'page.txt');
  return vault;
};

test('afterPack refuses a link inside a packed dependency that leaves the project', async () => {
  const { context } = await packageWithNestedLink(outsideProject);
  await assert.rejects(afterPack(context), (err: Error) => {
    assert.match(err.message, /node_modules\/jszip\/notes: .*outside the project/);
    assert.match(err.message, /1 stray file/);
    return true;
  });
});

test('afterPack checks the folder a nested link points at inside the project', async () => {
  const files = { 'drafts/a.txt': '' };
  const inProject = (_context: PackContext, project: string): string => path.join(project, 'drafts');
  await checked((await packageWithNestedLink(inProject, { files })).context);
  const { context, project } = await packageWithNestedLink(inProject, { files });
  put(project, `drafts/${CHAPTER}`);
  await assert.rejects(afterPack(context), /drafts\/Chapter 3\.txt: untracked file/);
});

test('afterPack follows a link in a linked package to find another inside it', async () => {
  const { context, project } = await fakePackage('win32', {
    files: { 'package-lock.json': LOCK, 'dictionaries/hu/index.dic': 'dic' },
    extra: ['node_modules/dictionary-hu/index.dic', 'node_modules/dictionary-hu/inner/page.txt'],
  });
  linkPackage(project, 'dictionary-hu', path.join(project, 'dictionaries', 'hu'));
  symlinkSync(outsideProject(context), path.join(project, 'dictionaries', 'hu', 'inner'), 'junction');
  await assert.rejects(afterPack(context), /node_modules\/dictionary-hu\/inner: .*outside the project/);
});

test('afterPack allows a nested link that stays inside node_modules', async () => {
  const inModules = (_context: PackContext, project: string): string => path.join(project, 'node_modules', 'dictionary-ro');
  const { context } = await packageWithNestedLink(inModules, {
    extra: ['node_modules/jszip/index.js', 'node_modules/jszip/notes/index.js'],
  });
  await checked(context);
});

test('afterPack reports a nested link that does not resolve', async () => {
  const { context } = await packageWithNestedLink((ctx) => {
    const gone = path.join(ctx.appOutDir, '..', 'gone');
    mkdirSync(gone);
    return gone;
  });
  rmSync(path.join(context.appOutDir, '..', 'gone'), { recursive: true });
  await assert.rejects(afterPack(context), /node_modules\/jszip\/notes: .*does not resolve/);
});

test('afterPack reports a top-level link once when both of its checks find it', async () => {
  const { context, project } = await fakePackage('win32', { extra: ['node_modules/linked/page.txt'] });
  linkPackage(project, 'linked', outsideProject(context));
  await assert.rejects(afterPack(context), (err: Error) => {
    assert.match(err.message, /1 stray file/);
    assert.match(err.message, /node_modules\/linked: .*outside the project/);
    return true;
  });
});

// A folder that is a git repository of its own, as an Obsidian vault can be. `git ls-files
// --others` in the outer repository reports nothing for what is inside it, so the sources are
// read from disk and every file in them must be in the tracked list. A fake vault in a temp
// folder, never a real one.
function nestedRepo(project: string, folder: string, files: string[]): void {
  for (const file of files) put(project, `${folder}/${file}`, 'words');
  execFileSync('git', ['init', '-q'], { cwd: path.join(project, folder) });
  execFileSync('git', ['add', '-A'], { cwd: path.join(project, folder) });
}

test('afterPack refuses a nested repository behind a nested link', async () => {
  for (const ignore of [false, true]) {
    const { context, project } = await fakePackage('win32', {
      files: { 'node_modules/jszip/index.js': '', ...(ignore ? { '.gitignore': 'vault/\n' } : {}) },
      extra: JSZIP,
    });
    nestedRepo(project, 'vault', ['notes/page.md']);
    linkPackage(project, 'jszip/notes', path.join(project, 'vault', 'notes'));
    await assert.rejects(afterPack(context), /vault\/notes\/page\.md: untracked file/, `ignored: ${ignore}`);
  }
});

test('afterPack refuses a nested repository named as an extraResources source or a lock link', async () => {
  const sources = {
    extraResources: { config: { extraResources: [{ from: 'vault/notes', to: 'notes' }] } },
    'a lock link': {
      files: {
        'package-lock.json': JSON.stringify({
          packages: { '': {}, 'node_modules/notes': { resolved: 'vault/notes', link: true } },
        }),
      },
    },
  };
  for (const [name, section] of Object.entries(sources)) {
    const { context, project } = await fakePackage('win32', section);
    nestedRepo(project, 'vault', ['notes/page.md']);
    await assert.rejects(afterPack(context), /vault\/notes\/page\.md: untracked file/, name);
  }
});

test('afterPack names a source folder that is itself a nested repository once', async () => {
  const { context, project } = await fakePackage('win32', {
    config: { extraResources: [{ from: 'vault', to: 'notes' }] },
  });
  nestedRepo(project, 'vault', ['notes/page.md', 'notes/two.md']);
  await assert.rejects(afterPack(context), (err: Error) => {
    assert.match(err.message, /vault: nested git repository/);
    assert.match(err.message, /1 stray file/);
    return true;
  });
});

test('afterPack reads a source folder from disk, finding deep files and following links inside it', async () => {
  const files = { 'drafts/a.txt': '', 'drafts/deep/b.txt': '', 'other/c.txt': '' };
  const config = { extraResources: [{ from: 'drafts', to: 'drafts' }] };
  await checked((await fakePackage('win32', { files, config })).context);

  const deep = await fakePackage('win32', { files, config });
  put(deep.project, `drafts/deep/${CHAPTER}`);
  await assert.rejects(afterPack(deep.context), /drafts\/deep\/Chapter 3\.txt: untracked file/);

  const leaving = await fakePackage('win32', { files, config });
  symlinkSync(outsideProject(leaving.context), path.join(leaving.project, 'drafts', 'inner'), 'junction');
  await assert.rejects(afterPack(leaving.context), /drafts\/inner: .*outside the project/);

  const inside = await fakePackage('win32', { files, config });
  symlinkSync(path.join(inside.project, 'other'), path.join(inside.project, 'drafts', 'more'), 'junction');
  put(inside.project, `other/${CHAPTER}`);
  await assert.rejects(afterPack(inside.context), /other\/Chapter 3\.txt: untracked file/);
});

test('afterPack refuses a source folder that is the whole project', async () => {
  const { context } = await fakePackage('win32', { config: { extraResources: [{ from: '.', to: 'x' }] } });
  await assert.rejects(afterPack(context), /cannot check extraResources ".": .*whole project/);
});

test('afterPack refuses a package-lock.json it cannot read', async () => {
  const { context } = await fakePackage('win32', { files: { 'package-lock.json': '{not json' } });
  await assert.rejects(afterPack(context), /cannot read package-lock\.json/);
});

test('afterPack looks for writing markers in the whole resources folder', async () => {
  const { context, resources } = await fakePackage('win32', {
    files: { 'licenses/hunspell/book.json': '{}' },
    config: HUNSPELL,
  });
  put(resources, 'licenses/hunspell/book.json');
  await assert.rejects(afterPack(context), /licenses\/hunspell\/book\.json: writing marker/);
});

test('afterPack leaves the files electron-builder and extraResources put beside the asar alone', async () => {
  const { context, resources } = await fakePackage('win32', {
    files: { 'licenses/hunspell/COPYING': 'mpl' },
    config: HUNSPELL,
  });
  for (const file of ['licenses/hunspell/COPYING', 'app-update.yml', 'elevate.exe']) put(resources, file);
  const line = await checked(context);
  assert.equal(line.other, 3);
  assert.equal(line.checked, TRACKED_FILES.length + UNTRACKED_FILES.length + 3);
});

test('afterPack fails when it cannot check', async () => {
  await assert.rejects(afterPack((await fakePackage('win32', { asar: false })).context), /app\.asar/);
  // not /git/: "not tracked by git" matches that, so a swallowed git failure would pass
  await assert.rejects(afterPack((await fakePackage('win32', { git: false })).context), /cannot read the tracked files/);
  const { context, resources } = await fakePackage('win32');
  writeFileSync(path.join(resources, 'app.asar'), 'not an archive');
  await assert.rejects(afterPack(context), /app\.asar/);
});
