import fs from 'node:fs';
import path from 'node:path';
import { writeFileDurable } from './durable.ts';
import type { ICloud } from './icloud.ts';
import type { Json, Log } from './types.ts';

export interface JsonFilesOptions {
  log: Log;
  icloud: ICloud;
  platform?: string;
}

export interface JsonFiles {
  parseJSONFile(file: string): Json | undefined;
  readJSON(file: string, fallback: Json): Json;
  writeJSON(file: string, data: Json): void;
  writeFileDurable(file: string, data: string | Buffer): void;
}

export function createJsonFiles({ log, icloud, platform = process.platform }: JsonFilesOptions): JsonFiles {
  const durable = (file: string, data: string | Buffer) => writeFileDurable(file, data, platform);

  // undefined, never null: a file holding `null` is a whole file
  const parseJSONFile = (file: string): Json | undefined => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
  };

  // JSON reads fall back on the copies a write leaves: the .tmp a write was making when it
  // stopped, then .bak, the last version that read whole. What they recover is put back as
  // the file itself.
  const readJSON = (file: string, fallback: Json): Json => {
    // still in iCloud: not unreadable, just not here. Falling back on .bak would write an
    // older copy over it.
    if (icloud.isCloudOnly(file)) throw icloud.cloudError(file);
    const main = parseJSONFile(file);
    if (main !== undefined) return main;
    if (!fs.existsSync(file) && !fs.existsSync(file + '.bak') && !fs.existsSync(file + '.tmp')) return fallback;
    for (const spare of [file + '.tmp', file + '.bak']) {
      if (icloud.isCloudOnly(spare)) continue;
      const v = parseJSONFile(spare);
      if (v === undefined) continue;
      log('recovered', `${file} was unreadable; restored from ${path.basename(spare)}`);
      try { durable(file, JSON.stringify(v, null, 2)); } catch (err) { log('recover write', err); }
      return v;
    }
    return fallback;
  };

  const writeJSON = (file: string, data: Json): void => {
    // the version on disk, while it reads whole, becomes the .bak (one still in iCloud
    // can't be read without waiting on it, so it isn't kept)
    if (!icloud.isCloudOnly(file) && parseJSONFile(file) !== undefined) {
      try { fs.copyFileSync(file, file + '.bak'); } catch { /* the write still goes ahead */ }
    }
    durable(file, JSON.stringify(data, null, 2));
  };

  return { parseJSONFile, readJSON, writeJSON, writeFileDurable: durable };
}
