import fs from 'node:fs';
import path from 'node:path';
import type { Log } from './types.ts';

// Finding a library folder NEO can save in, at launch. The questions to the writer are
// Electron's dialogs, so they are handed in as functions; everything else (the test file,
// the fall-back folder, which folder is tried next) lives here and runs without a window.

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A folder in Dropbox or one an antivirus watches can hold a file for a moment as it is
// made: the test file is tried again a few times, and once it was written, failing to delete
// it is no reason to say the folder can't be saved in (#474).
const PROBE_TRIES = 3;
const PROBE_RETRY = ['EBUSY', 'EPERM', 'EACCES', 'EAGAIN'];

export interface Probe {
  writable: boolean;
  /** Why not, for the question put to the writer. */
  error: NodeJS.ErrnoException | null;
}

export interface ProbeOptions {
  log: Log;
  /** Waits between tries; a test seam. */
  sleep?: (ms: number) => void;
}

// Can NEO write in this folder? Windows' Controlled folder access (Defender's ransomware
// protection) refuses new files in Documents to apps it doesn't know, and NEO is one. A
// small file written and removed tells.
export function probeFolder(dir: string, { log, sleep = sleepSync }: ProbeOptions): Probe {
  const probe = path.join(dir, '.neo-write-test');
  for (let n = 1; ; n++) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      try { fs.unlinkSync(probe); } catch { /* it is only a test file: the next one writes over it */ }
      return { writable: true, error: null };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (n < PROBE_TRIES && PROBE_RETRY.includes(error.code ?? '')) { sleep(150 * n); continue; }
      log('library folder not writable: ' + dir, err);
      return { writable: false, error };
    }
  }
}

export function isFolder(dir: string): boolean {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

export const libraryFileIn = (dir: string) => path.join(dir, 'library.json');

export interface StartupOptions {
  /** Where the library is meant to be. */
  dir: string;
  /** The writer picked this folder (it is in settings), so it is never swapped for another. */
  chosen: boolean;
  home: string;
  platform?: string;
  log: Log;
  /** The folder can't be saved in: 'choose' another, 'retry', or 'continue' without. */
  ask(dir: string, error: Error | null): 'choose' | 'retry' | 'continue';
  /** The writer's pick of a folder, or null when they cancel. */
  pick(): string | null;
  /** The library is at this folder from now on; remembered for the next launch. */
  remember(dir: string): void;
  sleep?: (ms: number) => void;
}

export interface StartupOutcome {
  dir: string;
  /** Set when a first library went beside Documents, for the notice shown once the window is up. */
  fallback: { from: string; to: string } | null;
}

// Where a first library goes when Documents itself can't hold one. Beside Documents, not
// nowhere: the writer is never left at "Start writing" with no way on.
export function fallbackLibraryDir(home: string, current: string, options: ProbeOptions): string | null {
  const spots: string[] = [];
  if (isFolder(path.join(home, 'Documents'))) spots.push(path.join(home, 'Documents', 'NEO Library'));
  spots.push(path.join(home, 'NEO Library'));
  return spots.find((dir) => dir !== current && probeFolder(dir, options).writable) ?? null;
}

// At startup, before any window: a library that can't be written is said plainly, once,
// with a way out, not as a hiccup at "Start writing".
export function checkLibraryWritable(o: StartupOptions): StartupOutcome {
  const probeOptions = { log: o.log, sleep: o.sleep };
  let dir = o.dir;
  // (only where it can happen: on Windows, and anywhere before a first library exists; a
  // synced library elsewhere isn't sent a test file every launch)
  const exists = fs.existsSync(libraryFileIn(dir));
  if ((o.platform ?? process.platform) !== 'win32' && exists) return { dir, fallback: null };
  // A first library that Documents can't hold goes beside it. Never when a library already
  // lives here or the writer picked this folder: their books stay where they are, and the
  // question below is theirs to answer.
  if (!exists && !o.chosen && !probeFolder(dir, probeOptions).writable) {
    const spot = fallbackLibraryDir(o.home, dir, probeOptions);
    if (spot) {
      o.remember(spot);
      return { dir: spot, fallback: { from: dir, to: spot } };
    }
  }
  for (let probe = probeFolder(dir, probeOptions); !probe.writable; probe = probeFolder(dir, probeOptions)) {
    const answer = o.ask(dir, probe.error);
    if (answer === 'continue') break;
    if (answer === 'choose') {
      const picked = o.pick();
      if (!picked) continue;
      dir = picked;
      o.remember(dir);
    }
  }
  return { dir, fallback: null };
}

export interface ChosenFolderOptions {
  /** The folder the writer chose in an earlier session. */
  chosen: string;
  /** Used for this session only, when the writer carries on without it. */
  fallback: string;
  ask(dir: string): 'retry' | 'choose' | 'continue';
  pick(): string | null;
  remember(dir: string): void;
}

// The writer's own library folder, missing at launch: a drive not plugged in, a NAS or
// cloud folder not mounted yet. Never swapped quietly for the default (new books would land
// there and seem lost when the drive came back). Asked: Try Again once it's there, Choose
// Folder, or Continue with the default folder for this session only; the choice stays saved.
export function awaitChosenLibrary(o: ChosenFolderOptions): string {
  while (!isFolder(o.chosen)) {
    const answer = o.ask(o.chosen);
    if (answer === 'continue') return o.fallback;
    if (answer === 'choose') {
      const picked = o.pick();
      if (picked) { o.remember(picked); return picked; }
    }
  }
  return o.chosen;
}
