import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function runTsc(...args: string[]) {
  const run = spawnSync(process.execPath, [tsc, ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

// skipLibCheck skips every .d.ts, ours as well as node_modules', so a typo in the SDK
// would turn a type into `any` for every plugin and still pass `npm run typecheck`.
test('a broken declaration file fails the typecheck', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'hoard-tsc-'));
  try {
    writeFileSync(path.join(tmp, 'broken.d.ts'), 'declare const place: NoSuchType;\n');
    writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({
      extends: path.join(root, 'tsconfig.json'),
      compilerOptions: { types: [] },
      include: ['broken.d.ts'],
    }));
    const { status, output } = runTsc('--noEmit', '-p', path.join(tmp, 'tsconfig.json'));
    assert.notEqual(status, 0, output);
    assert.match(output, /NoSuchType/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the typecheck covers our own declaration files', () => {
  const { status, output } = runTsc('--noEmit', '--listFilesOnly');
  assert.equal(status, 0, output);
  const listed = output.split(/\r?\n/).map((line) => line.replaceAll('\\', '/'));
  const ours = (file: string) => listed.some((line) => line.endsWith(`/${file}`) && !line.includes('/node_modules/'));
  for (const file of ['src/sdk/neo-plugins.d.ts', 'src/generated/place-v1.d.ts', 'src/generated/validators.d.cts']) {
    assert.ok(ours(file), `${file} is in the program`);
  }
});
