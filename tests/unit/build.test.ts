import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

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
