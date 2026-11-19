// A stand-in for `uv`, run as `node fake-uv.mjs ...` so it behaves the same on Windows and Linux.
// The test steers it through a control folder named by FAKE_UV_DIR (set on the test process,
// which the server passes down): `control.json` holds { exit, stdoutBytes }, and a `hold` file makes
// a run wait until a `release` file appears.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../git-support.ts';

interface Cleanup { after(fn: () => void): void }

const SCRIPT = `
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('uv 0.0.0-fake'); process.exit(0); }
const dir = process.env.FAKE_UV_DIR;
const control = existsSync(path.join(dir, 'control.json')) ? JSON.parse(readFileSync(path.join(dir, 'control.json'), 'utf8')) : {};
process.stdout.write(JSON.stringify({
  argv: args, cwd: realpathSync(process.cwd()),
  env: { UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT, PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE },
}) + '\\n');
if (control.stdoutBytes) process.stdout.write('x'.repeat(control.stdoutBytes));
process.stderr.write('fake stderr\\n');
process.exitCode = control.exit ?? 0;
if (existsSync(path.join(dir, 'hold'))) {
  const timer = setInterval(() => { if (existsSync(path.join(dir, 'release'))) clearInterval(timer); }, 20);
}
`;

export interface FakeUv {
  uv: { command: string; args: string[] };
  /** Next runs exit with `code`; `stdoutBytes` adds that many bytes of filler to stdout. */
  steer(control: { exit?: number; stdoutBytes?: number }): void;
  /** Runs started after this wait until `release()`. */
  hold(): void;
  release(): void;
}

export function fakeUv(t: Cleanup): FakeUv {
  const dir = tempDir(t, 'neo-fake-uv-');
  const script = path.join(dir, 'fake-uv.mjs');
  const control = path.join(dir, 'control');
  mkdirSync(control);
  writeFileSync(script, SCRIPT);
  const saved = process.env.FAKE_UV_DIR;
  process.env.FAKE_UV_DIR = control;
  t.after(() => { if (saved === undefined) delete process.env.FAKE_UV_DIR; else process.env.FAKE_UV_DIR = saved; });
  return {
    uv: { command: process.execPath, args: [script] },
    steer: (c) => writeFileSync(path.join(control, 'control.json'), JSON.stringify(c)),
    hold: () => writeFileSync(path.join(control, 'hold'), ''),
    release: () => writeFileSync(path.join(control, 'release'), ''),
  };
}
