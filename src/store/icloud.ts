import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { StoreError } from './types.ts';

// Files iCloud has taken off this Mac ("Optimize Mac Storage") stay in the folder as
// placeholders: the name and size are there, the words aren't. Reading one makes macOS
// fetch it first, and if iCloud is stuck that read never ends. NEO's main process would
// wait with it: no window, no menus, nothing. So a placeholder is never read directly. NEO
// asks iCloud for it, waits without freezing, and if it still hasn't come, leaves it be
// (and never writes over it) until it does.

const SF_DATALESS = 0x40000000;
const SIMULTANEOUS_ASKS = 4;

export interface ICloudOptions {
  platform?: string;
  /** How long a read waits for iCloud before it gives up on the files still away. */
  waitMs?: number;
  /** How often a waiting read looks again. */
  pollMs?: number;
  /** Test seam: which of these files are placeholders. */
  detect?: (files: string[]) => Set<string>;
  /** Test seam: ask iCloud for one file; `done` when it has answered. */
  download?: (file: string, done: () => void) => void;
}

export interface ICloud {
  waitMs: number;
  cloudOnlyAmong(files: Iterable<string>): Set<string>;
  isCloudOnly(file: string): boolean;
  requestDownload(files: Iterable<string>): void;
  /** null when every file is here; otherwise settles with whatever is still away. */
  whenLocal(files: string[], ms?: number): Promise<Set<string>> | null;
  /** Runs `read` at once when the files are here, later when iCloud brings them, or `away` if it never does. */
  afterLocal<T>(files: string[], read: () => T, away: (left: Set<string>) => T): T | Promise<T>;
  cloudError(file: string): StoreError;
}

// no blocks on disk for a file that has a size, confirmed by its "dataless" flag (one stat
// for the lot)
function detectOnMac(files: string[]): Set<string> {
  const out = new Set<string>();
  const maybe: string[] = [];
  for (const f of files) {
    try { const st = fs.statSync(f); if (st.isFile() && st.size > 0 && st.blocks === 0) maybe.push(f); } catch { /* not there */ }
  }
  if (!maybe.length) return out;
  let flags: string[] | null = null;
  try {
    const r = spawnSync('/usr/bin/stat', ['-f', '%Xf', ...maybe], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0) flags = String(r.stdout).trim().split('\n');
  } catch { /* no stat: the blocks decide */ }
  maybe.forEach((f, i) => {
    if (!flags || flags.length !== maybe.length || (parseInt(flags[i], 16) & SF_DATALESS)) out.add(f);
  });
  return out;
}

function askBrctl(file: string, done: () => void): void {
  try { execFile('/usr/bin/brctl', ['download', file], { timeout: 60000 }, done); } catch { done(); }
}

export function createICloud(options: ICloudOptions = {}): ICloud {
  const platform = options.platform ?? process.platform;
  const detect = options.detect ?? detectOnMac;
  const download = options.download ?? askBrctl;
  const pollMs = options.pollMs ?? 300;
  const asked = new Set<string>();
  const queue: string[] = [];
  let asking = 0;

  // Each method reaches its siblings through `icloud`, so replacing one (a test, or a vm
  // standing in for iCloud) changes what the others see.
  const icloud: ICloud = {
    waitMs: options.waitMs ?? 30000,

    cloudOnlyAmong(files) {
      return platform === 'darwin' ? detect([...files]) : new Set();
    },

    isCloudOnly(file) {
      return icloud.cloudOnlyAmong([file]).has(file);
    },

    // each file once at a time, a few asks at once however many there are
    requestDownload(files) {
      for (const f of files) {
        if (asked.has(f)) continue;
        asked.add(f);
        queue.push(f);
      }
      while (asking < SIMULTANEOUS_ASKS && queue.length) {
        const f = queue.shift() as string;
        asking++;
        download(f, () => { asking--; asked.delete(f); icloud.requestDownload([]); });
      }
    },

    whenLocal(files, ms = icloud.waitMs) {
      let away = icloud.cloudOnlyAmong(files);
      if (!away.size) return null;
      icloud.requestDownload(away);
      const until = Date.now() + ms;
      return new Promise((resolve) => {
        const look = () => {
          away = icloud.cloudOnlyAmong([...away]);
          if (!away.size || Date.now() >= until) return resolve(away);
          setTimeout(look, pollMs);
        };
        setTimeout(look, pollMs);
      });
    },

    afterLocal(files, read, away) {
      const wait = icloud.whenLocal(files);
      if (!wait) return read();
      return wait.then((left) => (left.size ? away(left) : read()));
    },

    cloudError(file) {
      return new StoreError('cloud_only', 'Still in iCloud, not on this Mac yet: ' + file);
    },
  };
  return icloud;
}
