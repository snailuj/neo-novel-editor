import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const gen = path.join(root, 'tools', 'gen.mjs');
const fixtures = path.join(root, 'tests', 'fixtures', 'manifests');

function runGen(...args: string[]) {
  return runScript(gen, ...args);
}

function runScript(script: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

function fixtureFiles(kind: 'valid' | 'invalid'): string[] {
  return readdirSync(path.join(fixtures, kind)).sort();
}

function readFixture(kind: 'valid' | 'invalid', name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtures, kind, name), 'utf8'));
}

test('generated files match', () => {
  const { status, output } = runGen('--check');
  assert.equal(status, 0, output);
});

test('drift is caught', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hoard-gen-'));
  try {
    cpSync(path.join(root, 'schemas'), path.join(tmp, 'schemas'), { recursive: true });
    cpSync(path.join(root, 'src', 'generated'), path.join(tmp, 'src', 'generated'), { recursive: true });
    assert.equal(runGen('--check', '--root', tmp).status, 0, 'an untouched copy matches');

    const file = path.join(tmp, 'schemas', 'plugin-manifest-v1.json');
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    schema.properties.homepage = { type: 'string' };
    writeFileSync(file, JSON.stringify(schema, null, 2) + '\n');

    const { status, output } = runGen('--check', '--root', tmp);
    assert.equal(status, 1, output);
    assert.match(output, /plugin-manifest-v1\.d\.ts/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The CLI once ran only if import.meta.url equalled argv[1]. Node resolves symlinks for
// the first and not the second, so reaching the script through a link made it exit 0 having
// checked nothing, and the drift gate passed silently.
test('check cannot be skipped by reaching the script through a link', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hoard-gen-'));
  const link = path.join(tmp, 'link');
  try {
    // A copy of the command beside a library that reports drift: the test is about how the
    // script is reached, not what it finds. The link leads to the copy, never into the
    // repository: a run cut off here leaves the link in the temp folder, and a recursive
    // delete by a tool that follows links would take the repository with it.
    const real = path.join(tmp, 'real');
    mkdirSync(real);
    copyFileSync(gen, path.join(real, 'gen.mjs'));
    writeFileSync(
      path.join(real, 'generate.mjs'),
      "export async function generate() { return { schemas: [], differing: ['src/generated/validators.cjs'] }; }\n",
    );
    symlinkSync(real, link, 'junction');
    assert.ok(realpathSync(link).startsWith(realpathSync(tmp)), 'the link stays in the temp folder');
    for (const script of [path.join(real, 'gen.mjs'), path.join(link, 'gen.mjs')]) {
      const { status, output } = runScript(script, '--check');
      assert.equal(status, 1, script + ': ' + output);
      assert.match(output, /validators\.cjs/);
    }
  } finally {
    // The link itself first; the recursive delete below then has none to meet.
    rmSync(link, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('line endings fixed', () => {
  const run = spawnSync('git', ['check-attr', 'eol', 'src/generated/validators.cjs'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(run.stdout, /eol: lf/);
  for (const file of ['validators.cjs', 'validators.d.cts', 'plugin-manifest-v1.d.ts']) {
    assert.doesNotMatch(readFileSync(path.join(root, 'src', 'generated', file), 'utf8'), /\r/, file);
  }
});

test('fixtures', async () => {
  const { validatePluginManifestV1: validate } = await import('../../src/generated/validators.cjs');
  assert.ok(fixtureFiles('valid').length > 0);
  for (const name of fixtureFiles('valid')) {
    assert.equal(validate(readFixture('valid', name)), true, `${name} passes`);
  }
  assert.deepEqual(fixtureFiles('invalid'), [
    'api-version-zero.json',
    'bad-id.json',
    'extra-key.json',
    'path-traversal.json',
    'too-many-commands.json',
  ]);
  for (const name of fixtureFiles('invalid')) {
    assert.equal(validate(readFixture('invalid', name)), false, `${name} fails`);
    assert.ok(validate.errors && validate.errors.length > 0, `${name} reports why`);
  }
});

test('CSP', () => {
  const text = readFileSync(path.join(root, 'src', 'generated', 'validators.cjs'), 'utf8');
  assert.doesNotMatch(text, /new Function|\beval\(/);
});
