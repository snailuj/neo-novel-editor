// The persisted index: `state.json` in the state folder, outside the library and outside
// git. `version: null` is a tombstone, kept so `changes` can report deletes.
//
// Every accepted change rewrites the whole file. At a few thousand paths that is a few
// hundred KB per change; an append-only log is the fix if that ever matters.
import { mkdir, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { writeFileDurable } from './durable.ts';
import type { Log } from './log.ts';

export interface Entry { version: string | null; seq: number }
export interface PersistedState { format: 1; seq: number; entries: Record<string, Entry> }

const FILE = 'state.json';

function valid(x: unknown): x is PersistedState {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Partial<PersistedState>;
  if (s.format !== 1 || !Number.isInteger(s.seq) || (s.seq as number) < 0) return false;
  if (typeof s.entries !== 'object' || s.entries === null) return false;
  return Object.values(s.entries).every((e) => (
    typeof e === 'object' && e !== null && Number.isInteger(e.seq) && e.seq >= 0 && e.seq <= (s.seq as number)
    && (e.version === null || typeof e.version === 'string')));
}

/** The saved state, or null when there is none or it cannot be read (an unreadable file is moved aside, never deleted). */
export async function loadState(dir: string, log: Log): Promise<PersistedState | null> {
  const file = path.join(dir, FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (valid(parsed)) return parsed;
  } catch { /* fall through to the aside path */ }
  const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await rename(file, aside);
  log('warn', 'state.corrupt', { file, movedTo: aside });
  return null;
}

export async function saveState(dir: string, state: PersistedState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileDurable(path.join(dir, FILE), JSON.stringify(state));
}

async function resolveExisting(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(p) === p) throw e;
    return path.join(await resolveExisting(path.dirname(p)), path.basename(p));
  }
}

/** The state folder must not sit in the repo: git would see it, and the library's own writes would race it. */
export async function assertOutsideRepo(state: string, repo: string): Promise<void> {
  const rel = path.relative(await resolveExisting(path.resolve(repo)), await resolveExisting(path.resolve(state)));
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
    throw new Error(`state folder ${state} is inside the repo ${repo}; give a folder outside it`);
  }
}
