// The provenance manifest: an append-only list of JSON lines that makes the verbatim
// guarantee machine-checkable. Ported from hoard's manifest.py.
//
// Every function here is pure. The command line reads and writes the file, hashes pages
// and asks git for history; it hands this module the text and a probe. Where the manifest
// lives is likewise the caller's business.
import type { ManifestRecordV1 } from '../generated/manifest-record-v1.js';
import { validateManifestRecordV1 } from '../generated/validators.cjs';
import { split } from './frontmatter.ts';
import { getLogger } from './log.ts';
import { pyStr, pyStrip, splitlines } from './py.ts';

export type { ManifestRecordV1 };

const log = getLogger('librarian.manifest');

/** A manifest that will not read, or a move the manifest's history forbids. */
export class ManifestError extends Error {
  override name = 'ManifestError';
}

/**
 * What `verify` needs from the vault, each path vault-relative. `hashInHistory` is true
 * when some committed version of `dest` hashes to `sha` (its body when `md`, the whole
 * file otherwise), following the file through renames and reading blobs as bytes.
 */
export interface VerifyProbe {
  exists(rel: string): boolean;
  bodySha(rel: string): string;
  fileSha(rel: string): string;
  hashInHistory(dest: string, sha: string, md: boolean): boolean;
}

/** The text a page's body_sha256 covers: everything after its frontmatter. */
export function hashedBody(text: string): string {
  return split(text).body;
}

/**
 * One record per non-blank line, each checked against the schema. Lines are split as
 * Python's splitlines() splits them, so a line number agrees with hoard's reading.
 */
export function parseManifest(text: string): ManifestRecordV1[] {
  const records: ManifestRecordV1[] = [];
  splitlines(text).forEach((line, i) => {
    if (!pyStrip(line)) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new ManifestError(`manifest line ${i + 1}: ${(err as Error).message}`);
    }
    if (!validateManifestRecordV1(value)) {
      const why = (validateManifestRecordV1.errors ?? [])
        .map((e) => `${e.instancePath || 'record'} ${e.message ?? 'is invalid'}`).join('; ');
      throw new ManifestError(`manifest line ${i + 1}: ${why}`);
    }
    records.push(value);
  });
  return records;
}

/**
 * The line hoard's `json.dumps(record) + "\n"` writes, byte for byte: `", "` and `": "`
 * between items, every character outside printable ASCII escaped, key order as given.
 * JSON.parse cannot tell 3.0 from 3, so a whole number prints as Python prints an int.
 */
export function serialiseRecord(record: ManifestRecordV1): string {
  return `${pyJson(record)}\n`;
}

function pyJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return pyJsonNumber(value);
  if (typeof value === 'string') return pyJsonString(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(', ')}]`;
  if (typeof value === 'object') {
    // An undefined value is an absent key in TypeScript; Python has no such value to write.
    const items = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${items.map(([k, v]) => `${pyJsonString(k)}: ${pyJson(v)}`).join(', ')}}`;
  }
  throw new ManifestError(`manifest: cannot write a ${typeof value}`);
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f',
};

// ensure_ascii: walking UTF-16 units writes an astral character as its surrogate pair,
// as Python does.
function pyJsonString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const unit = text.charCodeAt(i);
    if (SHORT_ESCAPES[ch]) out += SHORT_ESCAPES[ch];
    else if (unit >= 0x20 && unit <= 0x7e) out += ch;
    else out += `\\u${unit.toString(16).padStart(4, '0')}`;
  }
  return `${out}"`;
}

// float.__repr__: the shortest digits that round-trip, as JavaScript also finds them, in
// exponent form below 1e-4 with at least two exponent digits.
function pyJsonNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(n)) return BigInt(n).toString();
  const [mantissa, exp] = n.toExponential().split('e') as [string, string];
  const e = Number(exp);
  if (e < -4) return `${mantissa}e-${String(-e).padStart(2, '0')}`;
  return String(n);
}

/** Python's `str(record.get(key, fallback))`, for the messages hoard logs. */
function getStr(record: ManifestRecordV1, key: string, fallback: string): string {
  return Object.hasOwn(record, key) && record[key] !== undefined ? pyStr(record[key]) : fallback;
}

/** Latest record per dest, keyed in the order each dest first appears. */
function latestByDest(records: ManifestRecordV1[]): Map<string, ManifestRecordV1> {
  const latest = new Map<string, ManifestRecordV1>();
  for (const r of records) if (typeof r.dest === 'string') latest.set(r.dest, r);
  return latest;
}

export function alreadyIngested(records: ManifestRecordV1[], src: string, srcSha256: string): boolean {
  return records.some((r) => r.src === src && r.src_sha256 === srcSha256);
}

/**
 * The records with `record` appended, unless (src, dest, src_sha256) is already recorded.
 * `dedupe: false` is for a deliberate re-statement of a record already on that key: a
 * retire record keys to (None, dest, None), so an updated copy of one is
 * indistinguishable from a repeat and would be dropped.
 */
export function appendRecord(
  records: ManifestRecordV1[], record: ManifestRecordV1, { dedupe = true }: { dedupe?: boolean } = {},
): { records: ManifestRecordV1[]; added: boolean } {
  const keyOf = (r: ManifestRecordV1) => [r.src ?? null, r.dest ?? null, r.src_sha256 ?? null];
  const want = keyOf(record);
  if (dedupe && records.some((r) => keyOf(r).every((v, i) => v === want[i]))) {
    // A retire record has no src, and it is exactly the shape that collides on this key.
    log.info(`manifest: duplicate skipped ${getStr(record, 'src', '(retire)')} -> ${record.dest}`);
    return { records, added: false };
  }
  log.info(`manifest: recorded ${getStr(record, 'src', '(retire)')} -> ${record.dest} (${record.method})`);
  return { records: [...records, record], added: true };
}

// --- repair: absolute dests ---
// A dest is vault-relative by convention. Paths compare by component as pathlib's do:
// POSIX paths, plus Windows drive paths, whose components compare without case.

interface AbsolutePath {
  root: string;
  parts: string[];
  windows: boolean;
}

const DRIVE = /^[A-Za-z]:[\\/]/;

function absolutePath(p: string): AbsolutePath | null {
  const parts = (text: string, sep: RegExp) => text.split(sep).filter((part) => part !== '' && part !== '.');
  if (DRIVE.test(p)) return { root: p.slice(0, 2).toLowerCase(), parts: parts(p.slice(3), /[\\/]/), windows: true };
  if (!p.startsWith('/')) return null;
  // POSIX keeps exactly two leading slashes as a root of their own.
  const root = /^\/\/(?!\/)/.test(p) ? '//' : '/';
  return { root, parts: parts(p, /\//), windows: false };
}

/** The components of `dest` below `vaultRoot`, or null when it does not lie under it. */
function below(dest: AbsolutePath, vaultRoot: string): string[] | null {
  const root = absolutePath(vaultRoot);
  if (!root || root.windows !== dest.windows || root.root !== dest.root) return null;
  if (root.parts.length > dest.parts.length) return null;
  const same = (a: string, b: string) => (dest.windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!root.parts.every((part, i) => same(part, dest.parts[i]!))) return null;
  return dest.parts.slice(root.parts.length);
}

/**
 * The vault-relative form of an absolute `dest`, or null if no repair applies. A dest
 * outside the vault is left alone: media lives outside git by design (iron law 8), so an
 * absolute path there is correct, not damage.
 */
export function relativiseDest(dest: string, vaultRoot: string): string | null {
  const path = absolutePath(dest);
  const rest = path && below(path, vaultRoot);
  if (!rest) return null;
  return rest.length ? rest.join('/') : '.';
}

/**
 * Records with machine-absolute dests rewritten vault-relative, and each (old, new).
 * Order and every other key are kept; `src` is never touched. A second pass finds nothing.
 */
export function repairRecords(
  records: ManifestRecordV1[], vaultRoot: string,
): { records: ManifestRecordV1[]; changes: [string, string][] } {
  const repaired: ManifestRecordV1[] = [];
  const changes: [string, string][] = [];
  for (const record of records) {
    const dest = record.dest;
    const fixed = typeof dest === 'string' ? relativiseDest(dest, vaultRoot) : null;
    if (fixed === null) {
      repaired.push(record);
      continue;
    }
    changes.push([dest, fixed]);
    repaired.push({ ...record, dest: fixed });
  }
  return { records: repaired, changes };
}

/**
 * Absolute dests this machine cannot safely relativise. Only the checkout whose root
 * prefixes a dest can strip that prefix without guessing, so repair runs there.
 */
export function unrepairableDests(records: ManifestRecordV1[], vaultRoot: string): string[] {
  return records
    .map((r) => r.dest)
    .filter((dest) => {
      if (typeof dest !== 'string') return false;
      const path = absolutePath(dest);
      return path !== null && below(path, vaultRoot) === null;
    });
}

// --- moves ---

/**
 * The records a rename or shadow-copy appends: a tombstone and the carried pin. `verify`
 * judges the latest record per dest, so a `git mv` alone leaves the old dest missing and
 * the new one unpinned. The original hash is carried forward unchanged: the ghost is
 * byte-identical, and if the file evolved since ingest the history check still covers it
 * because git follows the rename. Throws (escalate, not guess) when the old dest is
 * already retired.
 *
 * An old dest with no record is not an error: librarian-authored pages were never
 * ingested and so never pinned, and iron law 10 still requires their moves be recorded.
 * Such a move yields one `rename` record on the new dest, with no tombstone, because
 * there is no pin to retire.
 */
export function moveRecords(
  records: ManifestRecordV1[], oldDest: string, newDest: string,
  { successor, reason, now }: { successor: string | null; reason: string; now: string },
): ManifestRecordV1[] {
  const prior = latestByDest(records).get(oldDest);
  if (prior === undefined) {
    return [{ dest: newDest, method: 'rename', moved_from: oldDest, reason, moved_at: now }];
  }
  if (prior.method === 'retire') throw new ManifestError(`move: ${oldDest} is already retired`);
  const tombstone: ManifestRecordV1 = { dest: oldDest, method: 'retire', successor, reason, retired_at: now };
  const carried: ManifestRecordV1 = { ...prior, dest: newDest, moved_from: oldDest, moved_at: now };
  return [tombstone, carried];
}

/**
 * Updated copies of the records whose `successor` still names `oldDest`. Rename the page
 * a tombstone points at and the pointer goes stale. Only the latest record per dest is
 * rewritten: copying a superseded record forward would make it latest again and lie to
 * `verify` about that dest. The caller appends these with `dedupe: false`, since a
 * retire copy shares its original's dedupe key.
 */
export function successorRewrites(records: ManifestRecordV1[], oldDest: string, newDest: string): ManifestRecordV1[] {
  return [...latestByDest(records).values()]
    .filter((r) => r.successor === oldDest)
    .map((r) => ({ ...r, successor: newDest }));
}

/** Groups of records sharing a content hash across different srcs: the dedupe signal. */
export function duplicates(records: ManifestRecordV1[]): ManifestRecordV1[][] {
  const byHash = new Map<string, ManifestRecordV1[]>();
  for (const r of records) {
    const hash = r.body_sha256 || r.file_sha256;
    if (!hash) continue;
    const group = byHash.get(hash);
    if (group) group.push(r);
    else byHash.set(hash, [r]);
  }
  const groups = [...byHash.values()].filter((g) => new Set(g.map((r) => r.src ?? null)).size > 1);
  log.info(`manifest: ${groups.length} duplicate content group(s)`);
  return groups;
}

/**
 * Findings for the latest record per dest; later records supersede earlier ones. A
 * working-tree mismatch whose pinned hash is in the dest's git history is authorial
 * evolution (A14), logged, not flagged.
 */
export function verify(records: ManifestRecordV1[], probe: VerifyProbe): string[] {
  const errors: string[] = [];
  for (const r of latestByDest(records).values()) {
    // A successor is a live pointer, not a note: it goes stale the moment the page it
    // names is renamed. Warn, never fail; the lineage claim is still true, and only a
    // human can say what the new path is.
    if (r.successor && !probe.exists(r.successor)) {
      log.warning(`${r.dest}: successor ${r.successor} does not exist`);
    }
    if (r.method === 'retire') {
      // A tombstone: renamed or discarded by the author, and the dest must be gone.
      if (probe.exists(r.dest)) errors.push(`${r.dest}: retired in manifest but still present`);
      else log.info(`${r.dest}: retired (${getStr(r, 'reason', 'no reason recorded')}; successor ${r.successor || 'none'})`);
      continue;
    }
    if (!probe.exists(r.dest)) {
      // A rename record carries no src: it pins a page authored here, not ingested.
      errors.push(`${r.dest}: missing (src ${r.src || 'none'})`);
      continue;
    }
    if (r.method !== 'verbatim') continue;
    const md = r.dest.endsWith('.md');
    const actual = md ? probe.bodySha(r.dest) : probe.fileSha(r.dest);
    const expected = md ? r.body_sha256 : r.file_sha256;
    if (actual === expected) continue;
    // With no pinned hash, no version in history can match it, so git is not asked.
    if (typeof expected === 'string' && probe.hashInHistory(r.dest, expected, md)) {
      log.info(`${r.dest}: evolved since ingest (verbatim at ingest verified)`);
    } else {
      errors.push(`${r.dest}: hash mismatch \u2014 verbatim law broken (src ${pyStr(r.src)})`);
    }
  }
  log.info(`manifest verify: ${errors.length} error(s) across ${records.length} record(s)`);
  return errors;
}
