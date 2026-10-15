// What hoard already holds of an old vault. hoard's `_meta/MANIFEST.jsonl` records each
// page it took in: `src` the page's path in the old vault (vault-relative, or a
// `git:<repo>@<rev>:<path>` source) and `src_sha256` its bytes then. A page those
// records name with the same bytes reaches the wiki through hoard's own copy, so it is
// not imported a second time; one they name with other bytes is newer than hoard's copy
// and is listed for the writer. Nothing here writes, in hoard or anywhere else.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseManifest } from '../../librarian/manifest.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';
export type HoardVerdict = 'through-hoard' | 'hoard-older';

function nearest(file: string, holds: (dir: string) => boolean): string | null {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (holds(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The old vault a page is in: the nearest folder above it holding .obsidian or .git. */
export function vaultRoot(file: string): string | null {
  return nearest(file, (dir) => existsSync(path.join(dir, '.obsidian')) || existsSync(path.join(dir, '.git')));
}

/** hoard's root, if this page came from hoard: the nearest folder above it holding _meta/MANIFEST.jsonl. */
export function hoardRoot(file: string): string | null {
  return nearest(file, (dir) => existsSync(path.join(dir, '_meta', 'MANIFEST.jsonl')));
}

const GIT_SOURCE = /^git:[^@\s]+@[0-9a-f]+:(.+)$/i;

export class HoardIndex {
  /** Hashes recorded for each vault-relative path. */
  readonly #byPath = new Map<string, Set<string>>();
  readonly #hashes = new Set<string>();
  /** Each manifest that did not read, with why. */
  readonly problems: string[] = [];

  /** Reads the manifest of each hoard root; one that does not read counts for nothing. */
  static read(roots: Iterable<string>, log: (level: Level, message: string, data?: unknown) => void): HoardIndex {
    const index = new HoardIndex();
    for (const root of new Set(roots)) {
      const file = path.join(root, '_meta', 'MANIFEST.jsonl');
      let records;
      try {
        records = parseManifest(readFileSync(file, 'utf8'));
      } catch (err) {
        const why = `${file}: ${err instanceof Error ? err.message : String(err)}`;
        index.problems.push(why);
        log('warn', `wiki: hoard's MANIFEST does not read, so no page counts as already in hoard: ${why}`);
        continue;
      }
      for (const r of records) {
        if (typeof r.src !== 'string' || typeof r.src_sha256 !== 'string') continue;
        const rel = (GIT_SOURCE.exec(r.src)?.[1] ?? r.src).replace(/\\/g, '/');
        const hashes = index.#byPath.get(rel) ?? new Set<string>();
        hashes.add(r.src_sha256);
        index.#byPath.set(rel, hashes);
        index.#hashes.add(r.src_sha256);
      }
      log('info', 'wiki.hoard-manifest', { file, records: records.length });
    }
    return index;
  }

  /** What hoard holds of this page of an old vault, given its bytes' SHA-256; null for nothing. */
  verdict(file: string, sha256: string): HoardVerdict | null {
    if (this.#hashes.has(sha256)) return 'through-hoard';
    const root = vaultRoot(file);
    if (root === null) return null;
    const rel = path.relative(root, path.resolve(file)).split(path.sep).join('/');
    return this.#byPath.has(rel) ? 'hoard-older' : null;
  }
}
