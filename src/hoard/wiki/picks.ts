// What an import makes of the files it was given, whatever it fills: a tree of
// page files (page-import.ts). A pick is a file, or an import list's entry
// (import-list.ts): a page with a name of its own, or sections of a page joined into one
// (a split). Sorting reads the picked files and says what importing each would do, given
// what the destination already holds; it never writes.
//
// A page whose source changed since it came in is an update while the destination has
// not changed the page, else it comes in beside it under a dated name, as NEO does with
// a chapter changed on two devices. A page an old vault gave hoard, by hoard's own
// manifest, is left to come in with hoard's pages, so it is not imported twice.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { split } from '../../librarian/frontmatter.ts';
import { key } from '../../librarian/links.ts';
import { AttachmentFinder, attachmentsIn } from './attachments.ts';
import { convertPage, type ConvertedPage } from './convert.ts';
import { type HoardIndex, vaultRoot } from './hoard-manifest.ts';
import { lineRange } from './import-list.ts';
import { section } from './sections.ts';

/**
 * A file to import, or an import list's entry: a name of its own, the folder of its tree
 * it goes in, or one section of it (a heading, or a line range with the start of the hash
 * the file had then).
 */
export interface Pick { path: string; name?: string | null; folder?: string | null; section?: string | null; sha?: string | null }

export interface Picked { path: string; name: string; folder: string | null; sections: string[]; sha: string | null }
/** An attachment a page names, and the file found for it. */
export interface Found { target: string; file: string }
export interface Converted { sha256: string; page: ConvertedPage; attachments: Found[]; missing: string[] }

/** What importing one pick would do; an update or a page beside carries `Where`, the page it follows. */
export type VerdictOf<Where extends object> =
  | Picked & Converted & { kind: 'new' }
  | Picked & Converted & Where & { kind: 'update' | 'beside' }
  | Picked & { kind: 'same' | 'clash' | 'through-hoard' | 'hoard-older' }
  | Picked & { kind: 'unreadable'; why: string };

export interface SortedOf<Where extends object> { verdicts: VerdictOf<Where>[]; picks?: Pick[] }

/** A page the destination holds, by the source it came from. */
export interface KnownPage<At> { at: At; title: string; sha256: string }

export interface SortContext<At, Where extends object> {
  /** The newest page for each source, by pickKey. */
  bySource: Map<string, KnownPage<At>>;
  /** Every name taken where the pages go, by link key; sorting adds the names it gives. */
  names: Set<string>;
  hoard: HoardIndex | null;
  /** True while the destination has not changed the page since an import wrote it. */
  untouched(at: At): boolean;
  /** How a verdict names the page it follows. */
  where(at: At): Where;
  /** Why a name cannot be a page's there, or null when it can. */
  refuseName?(name: string): string | null;
  /** The day a page that comes in beside another is dated, YYYY-MM-DD. */
  day: string;
  blockId(): string;
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const nameOf = (file: string) => path.basename(file).replace(/\.md$/i, '');
// Paths compare as the file system does: without case on Windows.
export const samePath = (file: string) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
export const pickKey = (p: { path: string; sections: readonly string[] }) => [samePath(p.path), ...p.sections].join('\n');
const byName = (a: Picked, b: Picked) => {
  const [ka, kb] = [key(a.name), key(b.name)];
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
};

/** Each file once, or each list entry's sections joined into the page it names. */
export function picked(picks: readonly (string | Pick)[]): Picked[] {
  const out: Picked[] = [];
  const whole = new Set<string>();
  const parts = new Map<string, Picked>();
  for (const raw of picks) {
    const pick: Pick = typeof raw === 'string' ? { path: raw } : raw;
    const name = pick.name || nameOf(pick.path);
    const folder = pick.folder ?? null;
    if (pick.section) {
      const k = `${samePath(pick.path)}\n${key(name)}`;
      const into = parts.get(k);
      if (into) {
        if (!into.sections.includes(pick.section)) into.sections.push(pick.section);
        into.sha ??= pick.sha ?? null;
        continue;
      }
      const p = { path: pick.path, name, folder, sections: [pick.section], sha: pick.sha ?? null };
      parts.set(k, p);
      out.push(p);
      continue;
    }
    if (whole.has(samePath(pick.path))) continue;
    whole.add(samePath(pick.path));
    out.push({ path: pick.path, name, folder, sections: [], sha: null });
  }
  return out.sort(byName);
}

/**
 * The Markdown a pick brings in, converted: the page, or its sections or line ranges
 * joined, without the frontmatter of the page they were cut from; or why it cannot be.
 */
export function convertPick(p: Picked, bytes: Buffer, finders: Map<string, AttachmentFinder>, blockId: () => string): Converted | { why: string } {
  let text = bytes.toString('utf8');
  if (p.sha && !sha256(bytes).startsWith(p.sha)) return { why: 'it changed after the list was made, so its lines may have moved' };
  if (p.sections.length) {
    const whole = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    // a file's last newline ends its last line and starts none
    const lines = whole.replace(/\n$/, '').split('\n');
    let body: string;
    try {
      ({ body } = split(whole));
    } catch (err) {
      return { why: err instanceof Error ? err.message : String(err) };
    }
    const cut: string[] = [];
    for (const heading of p.sections) {
      const range = lineRange(heading);
      if (range) {
        if (range.end > lines.length) return { why: `it has only ${lines.length} lines, not ${range.end}` };
        cut.push(lines.slice(range.start - 1, range.end).join('\n').replace(/\s+$/, ''));
        continue;
      }
      const part = section(body, heading);
      if (part === null) return { why: `it has no heading “${heading}”` };
      cut.push(part);
    }
    text = `${cut.join('\n\n')}\n`;
  }
  let page: ConvertedPage;
  try {
    page = convertPage(text, blockId);
  } catch (err) {
    return { why: err instanceof Error ? err.message : String(err) };
  }
  const root = vaultRoot(p.path) ?? path.dirname(path.resolve(p.path));
  let finder = finders.get(root);
  if (!finder) finders.set(root, finder = new AttachmentFinder(root));
  const attachments: Found[] = [];
  const missing: string[] = [];
  for (const target of attachmentsIn(text)) {
    const file = finder.find(target, p.path);
    if (file) attachments.push({ target, file });
    else missing.push(target);
  }
  return { sha256: sha256(bytes), page, attachments, missing };
}

/** What importing these picks would do, given what the destination holds. Reads; never writes. */
export function sortPicks<At, Where extends object>(picks: readonly (string | Pick)[], c: SortContext<At, Where>): VerdictOf<Where>[] {
  const finders = new Map<string, AttachmentFinder>();
  return picked(picks).map((p): VerdictOf<Where> => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(p.path);
    } catch (err) {
      return { ...p, kind: 'unreadable', why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'the file is not there' : String(err) };
    }
    const known = c.bySource.get(pickKey(p));
    if (known && known.sha256 === sha256(bytes)) return { ...p, name: known.title, kind: 'same' };
    if (!known && !p.sections.length) {
      const held = c.hoard?.verdict(p.path, sha256(bytes));
      if (held) return { ...p, kind: held };
    }
    if (!known) {
      const refused = c.refuseName?.(p.name);
      if (refused) return { ...p, kind: 'unreadable', why: refused };
      if (c.names.has(key(p.name))) return { ...p, kind: 'clash' };
    }
    const made = convertPick(p, bytes, finders, c.blockId);
    if ('why' in made) return { ...p, kind: 'unreadable', why: made.why };
    if (!known) {
      c.names.add(key(p.name));
      return { ...p, ...made, kind: 'new' };
    }
    if (c.untouched(known.at)) return { ...p, ...made, ...c.where(known.at), name: known.title, kind: 'update' };
    let name = `${p.name} (source changed ${c.day})`;
    for (let n = 2; c.names.has(key(name)); n++) name = `${p.name} (source changed ${c.day}, ${n})`;
    c.names.add(key(name));
    return { ...p, ...made, ...c.where(known.at), name, kind: 'beside' };
  });
}
