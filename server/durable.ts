// Durable file writes that behave the same on Linux and Windows: write a temp file in
// the target folder, fsync it, rename it over the target, then fsync the folder where
// the platform lets us.
import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Log } from './log.ts';
import { TEMP_PREFIX } from './paths.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows refuses a rename for a moment while a scanner or another handle lets go. */
export async function renameRetrying(from: string, to: string, attempts = 8): Promise<void> {
  for (let i = 1; ; i += 1) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || i >= attempts) throw e;
      await sleep(15 * i);
    }
  }
}

export type SyncDir = (dir: string) => Promise<void>;

/**
 * Folder fsync, best effort. Windows cannot open a folder for fsync and some filesystems refuse
 * it, which is silent. Anything else is logged as a warning: the change it follows has already
 * happened, so the failure must not abort the operation.
 */
export function makeSyncDir(log: Log): SyncDir {
  return async (dir) => {
    try {
      const handle = await open(dir, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EISDIR' || code === 'EINVAL' || code === 'EACCES' || code === 'ENOTSUP') return;
      log('warn', 'syncdir.failed', { dir, code });
    }
  };
}

export async function writeFileDurable(file: string, bytes: Buffer | string, sync: SyncDir): Promise<void> {
  const dir = path.dirname(file);
  const temp = path.join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameRetrying(temp, file);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
  await sync(dir);
}
