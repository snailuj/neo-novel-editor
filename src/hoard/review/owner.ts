// Who owns a page, from its page sidecar (.neo/pages/<tree>/<path>.json for a page in the
// wiki/ or sources/ folders). Hoard's rule: what the file records wins, so provenance.author's first
// voice decides; with no voice recorded, a librarian-authored type (lore, project) makes
// the page the librarian's. Anything else is the writer's, a page with no sidecar
// included, so a page of unknown ownership is never one the librarian changes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateHoardPageV1 } from '../../generated/validators.cjs';
import { parseId } from '../pages/identity.ts';

export type Owner = 'librarian' | 'author';

const LIBRARIAN = 'librarian';
const LIBRARIAN_TYPES = new Set(['lore', 'project']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// provenance.author is a list of alternatives, as a YAML list or a comma string.
function voices(frontmatter: Record<string, unknown>): string[] {
  const provenance = frontmatter['provenance'];
  const author = isRecord(provenance) ? provenance['author'] : undefined;
  const values = Array.isArray(author) ? author : [author];
  return values.filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function ownerFromFrontmatter(frontmatter: unknown): Owner {
  if (!isRecord(frontmatter)) return 'author';
  const recorded = voices(frontmatter);
  if (recorded.length) return recorded[0].toLowerCase() === LIBRARIAN ? 'librarian' : 'author';
  const type = frontmatter['type'];
  return typeof type === 'string' && LIBRARIAN_TYPES.has(type) ? 'librarian' : 'author';
}

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

/**
 * Who owns a page, named by its id (<tree>/<path>). Every sources/ page is the author's.
 * A wiki/ page is the librarian's only if its sidecar says so; a sidecar that is missing
 * or does not read leaves it the author's, since the librarian must never write to a
 * page it cannot show is its own. An id that is not a safe page id is refused.
 */
export async function ownerOf(library: string, page: string, log: Log = () => {}): Promise<Owner> {
  const ref = parseId(page);
  if (ref.tree === 'sources') return 'author';
  const file = path.join(library, '.neo', 'pages', ref.tree, ...ref.path.split('/')) + '.json';
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    log(missing ? 'info' : 'warn', `review: ${page} has ${missing ? 'no sidecar' : 'a sidecar that does not read'}, so it is the author's: ${String(err)}`, { file });
    return 'author';
  }
  if (!validateHoardPageV1(data)) {
    log('warn', `review: the sidecar of ${page} is not a page sidecar, so it is the author's`, validateHoardPageV1.errors);
    return 'author';
  }
  return ownerFromFrontmatter(data.frontmatter);
}
