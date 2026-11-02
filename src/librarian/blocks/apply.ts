// Applies a reviewed sheet. The writing bound for the library becomes an import list for
// Import List…: each page it names is cut from the vault's own file by line ranges, under
// a `to: sources` or `to: wiki` line, so the import records where every page came from
// and a source in sources/ lands in the folder its page is in. The included Morning Pages
// become one Markdown book for NEO's own Import (a `# date` heading per day makes a
// chapter each). The vault is only read. A block whose text no longer matches its id (the
// page changed since review) is not listed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getLogger } from '../log.ts';
import { defaultDest, DESTS, type Row, treeOf } from './sheet.ts';
import { type Block, splitBlocks } from './split.ts';

const log = getLogger('librarian.blocks.apply');

export interface ApplyOptions {
  /** Where the vault sits on the machine that will import, for import-list.txt; the vault's own path when not given. */
  vaultPrefix?: string;
}

export interface ApplyResult {
  written: string[];
  missing: { page: string; block: string; lines: string }[];
  /** Rows whose `dest` is still `check`. */
  unresolved: number;
}

const RECORD = '.blocks-apply.json';
/** How much of a page's SHA-256 a list line carries, so a page that changed is refused. */
const SHA_CHARS = 16;

/** One block for the old vault's import to cut by line range, guarded by the file's hash. */
export interface Pick {
  path: string;
  src_sha256: string;
  start: number;
  end: number;
  kind: 'writing' | 'morning-pages';
  /** The page in the library, or for morning-pages the book's chapter. */
  target: string;
  /** The tree a writing pick goes to. */
  dest?: 'sources' | 'wiki';
  why: string;
}

interface Page { sha: string; lines: string[]; blocks: Map<string, Block> }

// Each page read once, or null when it is not there.
function pageReader(vault: string): (page: string) => Page | null {
  const pages = new Map<string, Page | null>();
  return (page) => {
    if (!pages.has(page)) {
      const file = path.join(vault, page);
      const bytes = existsSync(file) ? readFileSync(file) : null;
      const text = bytes?.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      pages.set(page, bytes && {
        sha: createHash('sha256').update(bytes).digest('hex'),
        lines: text!.replace(/\n$/, '').split('\n'),
        blocks: new Map(splitBlocks(bytes.toString('utf8')).map((b) => [b.id, b])),
      });
    }
    return pages.get(page)!;
  };
}

function checkDests(rows: readonly Row[]): void {
  for (const r of rows) {
    if (!(DESTS as readonly string[]).includes(r.dest)) throw new Error(`dest '${r.dest}' (${r.page} lines ${r.lines}) is not one of ${DESTS.join(', ')}`);
  }
}

const pageName = (r: Row) => r.dest_page || defaultDest(r.page, r.heading);

/**
 * The sheet's decisions as line-range picks, in sheet order: a block bound for the
 * library and the book gives one pick for each. A block no longer in its page gives none
 * and is named in `missing`.
 */
export function blockPicks(vault: string, rows: readonly Row[]): { picks: Pick[]; missing: ApplyResult['missing'] } {
  checkDests(rows);
  const read = pageReader(vault);
  const picks: Pick[] = [];
  const missing: ApplyResult['missing'] = [];
  for (const row of rows) {
    const tree = treeOf(row);
    if (!tree && !row.book) continue;
    const page = read(row.page);
    const block = page?.blocks.get(row.block);
    if (!page || !block) {
      missing.push({ page: row.page, block: row.block, lines: row.lines });
      continue;
    }
    const base = { path: row.page, src_sha256: page.sha, start: block.start, end: block.end, why: row.reason || row.label };
    if (tree) picks.push({ ...base, kind: 'writing', target: pageName(row), dest: tree });
    if (row.book) picks.push({ ...base, kind: 'morning-pages', target: row.book });
  }
  return { picks, missing };
}
const ONE_SEGMENT = /^(?!\.\.?$)[^\\/\0]+$/;
const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

// The line of the nearest heading above a block that reads `text`, 1-based; null if none.
function headingLine(lines: readonly string[], block: Block, text: string): number | null {
  for (let i = block.start - 2; i >= 0; i--) {
    const m = HEADING.exec(lines[i]!);
    if (m && m[1] === text) return i + 1;
  }
  return null;
}

/** A Morning Pages line as prose: links become their text; comments and embeds' marks go. */
export function bookText(line: string): string {
  return line
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, shown?: string) => (shown ?? target).trim())
    .replace(/[ \t]+$/, '');
}

/** A block as book paragraphs: one per line for lists and fences, so NEO keeps them apart. */
function bookParagraphs(block: Block): string[] {
  const lines = block.text.split('\n');
  const perLine = block.kind === 'list-item' || block.kind === 'fence' || block.kind === 'table';
  const paras = perLine ? lines.map((l) => l.trim()).filter(Boolean) : [lines.map((l) => l.trim()).join('\n')];
  // NEO's Import starts a chapter at any line opening with '#'; a zero-width space keeps it text.
  return paras.map((p) => bookText(p).split('\n').map((l) => (/^#{1,6}(\s|$)/.test(l) ? `​${l}` : l)).join('\n')).filter((p) => p.trim());
}

export function applySheet(vault: string, rows: readonly Row[], out: string, opts: ApplyOptions): ApplyResult {
  checkDests(rows);
  const result: ApplyResult = { written: [], missing: [], unresolved: rows.filter((r) => r.dest === 'check').length };
  const read = pageReader(vault);
  const blockOf = (r: Row) => {
    const b = read(r.page)?.blocks.get(r.block);
    if (!b) result.missing.push({ page: r.page, block: r.block, lines: r.lines });
    return b;
  };

  // A page of the library by tree and name, cut from one page of the vault.
  const library = new Map<string, { tree: 'sources' | 'wiki'; name: string; page: string; items: { row: Row; block: Block }[] }>();
  const book = new Map<string, { row: Row; block: Block }[]>();
  for (const row of rows) {
    const tree = treeOf(row);
    if (!tree && !row.book) continue;
    const block = blockOf(row);
    if (!block) continue;
    if (tree) {
      const name = pageName(row);
      if (!ONE_SEGMENT.test(name)) throw new Error(`dest_page '${name}' (${row.page} lines ${row.lines}) must be one file name`);
      const k = `${tree}\0${name}`;
      const into = library.get(k);
      if (into && into.page !== row.page) {
        throw new Error(`dest_page '${name}' in ${tree} takes blocks from ${into.page} and ${row.page}; a page is cut from one page of the vault, so give each its own name`);
      }
      if (into) into.items.push({ row, block });
      else library.set(k, { tree, name, page: row.page, items: [{ row, block }] });
    }
    if (row.book) book.set(row.book, [...(book.get(row.book) ?? []), { row, block }]);
  }
  for (const m of result.missing) log.warning(`${m.page}: block ${m.block} (lines ${m.lines}) is not in the page any more; not listed`);

  const written: string[] = [];
  const write = (rel: string, text: string) => {
    const file = path.join(out, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.push(rel);
  };

  if (book.size) {
    const chapters = [...book.keys()].sort();
    const parts = ['Morning Pages'];
    for (const title of chapters) {
      parts.push(`# ${title}`);
      for (const { block } of book.get(title)!) parts.push(...bookParagraphs(block));
    }
    write('Morning Pages.md', `${parts.join('\n\n')}\n`);
  }

  if (library.size) {
    const prefix = (opts.vaultPrefix ?? vault).replace(/[\\/]+$/, '');
    const sep = prefix.includes('\\') ? '\\' : '/';
    const lines = ['# Written by blocks apply from the review sheet: each page is cut from its vault page by lines.'];
    for (const tree of ['sources', 'wiki'] as const) {
      const pages = [...library.values()].filter((p) => p.tree === tree).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (!pages.length) continue;
      lines.push('', `to: ${tree}`);
      for (const p of pages) {
        const page = read(p.page)!;
        const file = [prefix, ...p.page.split('/')].join(sep);
        const ranges: [number, number][] = [];
        // Blocks from more than one heading keep their headings, as the vault page has them.
        const parts = new Set(p.items.map(({ row }) => row.heading)).size > 1;
        let last: string | null = null;
        for (const { row, block } of p.items) {
          if (parts && row.heading !== last) {
            const at = headingLine(page.lines, block, row.heading.split(' > ').pop() ?? '');
            if (at !== null) ranges.push([at, at]);
          }
          last = row.heading;
          ranges.push([block.start, block.end]);
        }
        for (const [start, end] of ranges) lines.push(`${file}#L${start}-L${end}@${page.sha.slice(0, SHA_CHARS)} -> ${p.name}`);
      }
    }
    write('import-list.txt', `${lines.join('\n')}\n`);
  }

  // What the last run wrote and this one did not goes, so a re-run is the sheet's state.
  const recordFile = path.join(out, RECORD);
  const before: string[] = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, 'utf8')) as string[] : [];
  for (const rel of before) {
    if (!written.includes(rel) && existsSync(path.join(out, rel))) {
      rmSync(path.join(out, rel));
      log.info(`removed ${rel}, which the sheet no longer writes`);
    }
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(recordFile, JSON.stringify(written, null, 2));
  result.written = written;
  const trees = [...library.values()];
  log.info(`listed ${trees.filter((p) => p.tree === 'sources').length} source pages and ${trees.filter((p) => p.tree === 'wiki').length} wiki pages, and wrote ${book.size} Morning Pages chapters; ${result.missing.length} blocks changed since review; ${result.unresolved} rows still to check`);
  return result;
}
