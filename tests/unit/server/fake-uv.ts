// A stand-in for `uv`, run as `node fake-uv.mjs ...` so it behaves the same on Windows and Linux.
// The test steers it through a control folder named by FAKE_UV_DIR (set on the test process,
// which the server passes down): `control.json` holds { exit, stdoutBytes, hangVersion, ignoreTerm, grandchildMs }, and a `hold` file makes
// a run wait until a `release` file appears.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../git-support.ts';

interface Cleanup { after(fn: () => void): void }

const SCRIPT = `
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
const dir = process.env.FAKE_UV_DIR;
const control = existsSync(path.join(dir, 'control.json')) ? JSON.parse(readFileSync(path.join(dir, 'control.json'), 'utf8')) : {};
if (args[0] === '--version') {
  if (control.hangVersion) setInterval(() => {}, 1000);
  else { console.log('uv 0.0.0-fake'); process.exit(0); }
} else {
if (control.ignoreTerm) process.on('SIGTERM', () => {});
if (control.grandchildMs) {
  // Outlives this process while holding its stdout, as a python child of a real uv would.
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + control.grandchildMs + ')'], { cwd: tmpdir(), stdio: ['ignore', 'inherit', 'inherit'] }).unref();
}
process.stdout.write(JSON.stringify({
  argv: args, cwd: realpathSync(process.cwd()),
  env: { UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT, PYTHONDONTWRITEBYTECODE: process.env.PYTHONDONTWRITEBYTECODE },
}) + '\\n');
if (control.stdoutBytes) process.stdout.write('x'.repeat(control.stdoutBytes));
process.stderr.write('fake stderr\\n');
process.exitCode = control.exit ?? 0;
if (existsSync(path.join(dir, 'hold'))) {
  appendFileSync(path.join(dir, 'held'), 'x');
  const timer = setInterval(() => { if (existsSync(path.join(dir, 'release'))) clearInterval(timer); }, 20);
}
}
`;

export interface FakeUv {
  uv: { command: string; args: string[] };
  /** Next runs exit with `code`; `stdoutBytes` adds that many bytes of filler to stdout. */
  steer(control: { exit?: number; stdoutBytes?: number; hangVersion?: boolean; ignoreTerm?: boolean; grandchildMs?: number }): void;
  /** Runs started after this wait until `release()`. */
  hold(): void;
  release(): void;
  /** Resolves once `n` runs are waiting on the hold, so a test never races the fake's start-up. */
  waitHeld(n: number): Promise<void>;
  /** Runs started after this do not wait; runs already waiting still need `release()`. */
  unhold(): void;
  /** Writes the script, for a fake made with `installed: false`. */
  install(): void;
}

/** `installed: false` leaves the script unwritten, so `uv` is missing until `install()`. */
export function fakeUv(t: Cleanup, { installed = true } = {}): FakeUv {
  const dir = tempDir(t, 'neo-fake-uv-');
  const script = path.join(dir, 'fake-uv.mjs');
  const control = path.join(dir, 'control');
  mkdirSync(control);
  const install = () => writeFileSync(script, SCRIPT);
  if (installed) install();
  const saved = process.env.FAKE_UV_DIR;
  process.env.FAKE_UV_DIR = control;
  t.after(() => { if (saved === undefined) delete process.env.FAKE_UV_DIR; else process.env.FAKE_UV_DIR = saved; });
  return {
    uv: { command: process.execPath, args: [script] },
    steer: (c) => writeFileSync(path.join(control, 'control.json'), JSON.stringify(c)),
    hold: () => writeFileSync(path.join(control, 'hold'), ''),
    waitHeld: async (n) => {
      for (let i = 0; i < 500; i++) {
        if (existsSync(path.join(control, 'held')) && readFileSync(path.join(control, 'held'), 'utf8').length >= n) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`fewer than ${n} runs reached the hold`);
    },
    unhold: () => rmSync(path.join(control, 'hold'), { force: true }),
    release: () => writeFileSync(path.join(control, 'release'), ''),
    install,
  };
}
