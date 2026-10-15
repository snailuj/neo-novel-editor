// A ripple case read from git as the vault stood just before its source came in. Read
// today, a target that ripple already linked to its source would look near it; the
// Jev evaluation's review found exactly that contamination. Read-only git commands.
import { execFileSync } from 'node:child_process';
import { decodeText } from '../../librarian/vault-fs.ts';
import { inRoster, type Source } from './shortlist.ts';

export interface Snapshot {
  /** The commit that added the source. */
  added: string;
  /** Its parent, where the corpus is read; null when the source came in the first commit. */
  before: string | null;
  source: Source;
  notes: [string, string][];
}

const MAX = 1 << 30;

function git(repo: string, args: string[], input?: string): Buffer {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo, input, maxBuffer: MAX, stdio: ['pipe', 'pipe', 'pipe'] });
}

const LENIENT = new TextDecoder('utf-8');

function text(bytes: Uint8Array): string {
  try {
    return decodeText(bytes);
  } catch {
    // A page that is not UTF-8 still ranks on what reads; hoard would refuse it elsewhere.
    return LENIENT.decode(bytes).replace(/\r\n?/g, '\n');
  }
}

/** Every blob named in `specs`, through one `git cat-file --batch`. */
function readBlobs(repo: string, specs: string[]): Uint8Array[] {
  if (!specs.length) return [];
  const out = git(repo, ['cat-file', '--batch'], `${specs.join('\n')}\n`);
  const blobs: Uint8Array[] = [];
  let at = 0;
  for (const spec of specs) {
    const nl = out.indexOf(0x0a, at);
    const header = out.subarray(at, nl).toString('utf8');
    const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1]);
    if (!Number.isFinite(size)) throw new Error(`git cat-file could not read ${spec}: ${header}`);
    blobs.push(out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return blobs;
}

export function readSnapshot(repo: string, sourceRel: string, zones?: readonly string[]): Snapshot {
  const added = git(repo, ['log', '--diff-filter=A', '--format=%H', '-1', 'HEAD', '--', sourceRel]).toString('utf8').trim();
  if (!added) throw new Error(`${sourceRel} was never added in this repository's history`);
  const source: Source = { relpath: sourceRel, text: text(readBlobs(repo, [`${added}:${sourceRel}`])[0]!) };
  let before: string | null;
  try {
    before = git(repo, ['rev-parse', '--verify', '--quiet', `${added}^`]).toString('utf8').trim() || null;
  } catch {
    before = null; // the source came in the first commit: nothing stood before it
  }
  if (!before) return { added, before, source, notes: [] };
  const paths = git(repo, ['ls-tree', '-r', '-z', '--name-only', before]).toString('utf8').split('\0')
    .filter((p) => p && !p.includes('\n') && inRoster(p, zones));
  const blobs = readBlobs(repo, paths.map((p) => `${before}:${p}`));
  return { added, before, source, notes: paths.map((p, i) => [p, text(blobs[i]!)]) };
}
