// Who owns a page, from its page sidecar (.neo/<bookId>/pages/<chId>.json, written by
// Import to Wiki). Hoard's rule: what the file records wins, so provenance.author's first
// voice decides; with no voice recorded, a librarian-authored type (lore, project) makes
// the page the librarian's. Anything else is the writer's, a chapter with no page sidecar
// included, so a page of unknown ownership is never one the librarian changes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateHoardPageV1 } from '../../generated/validators.cjs';
import { oneName } from '../files.ts';

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

export function ownerOf(frontmatter: unknown): Owner {
  if (!isRecord(frontmatter)) return 'author';
  const recorded = voices(frontmatter);
  if (recorded.length) return recorded[0].toLowerCase() === LIBRARIAN ? 'librarian' : 'author';
  const type = frontmatter['type'];
  return typeof type === 'string' && LIBRARIAN_TYPES.has(type) ? 'librarian' : 'author';
}

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

/** The chapters of a book that are the librarian's; reading never writes. */
export function librarianPages(library: string, bookId: string, log: Log): string[] {
  const dir = path.join(library, '.neo', oneName(bookId, 'bookId'), 'pages');
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      log('warn', `review: ${file} does not read, so its page is the writer's: ${String(err)}`);
      continue;
    }
    if (!validateHoardPageV1(data)) {
      log('warn', `review: ${file} is not a page sidecar, so its page is the writer's`, validateHoardPageV1.errors);
      continue;
    }
    if (ownerOf(data.frontmatter) === 'librarian') found.push(name.slice(0, -'.json'.length));
  }
  return found;
}
