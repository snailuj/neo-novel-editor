// Applies a reviewed sheet: the included writing becomes wiki pages for Import List to
// Wiki, and the included Morning Pages one Markdown book for NEO's own Import (a `# date`
// heading per day makes a chapter each). The vault is only read. A block whose text no
// longer matches its id (the page changed since review) is not written.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getLogger } from '../log.ts';
import { defaultBook, defaultDest, type Row } from './sheet.ts';
import { type Block, splitBlocks } from './split.ts';

const log = getLogger('librarian.blocks.apply');

export interface ApplyOptions {
  /** Where the out folder sits on the machine that will import (for import-list.txt). */
  pathPrefix?: string;
}

export interface ApplyResult {
  written: string[];
  missing: { page: string; block: string; lines: string }[];
  /** Rows still marked `check`. */
  unresolved: number;
}

const RECORD = '.blocks-apply.json';
const ONE_SEGMENT = /^(?!\.\.?$)[^\\/\0]+$/;

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
  return paras.map((p) => bookText(p).split('\n').map((l) => (/^#{1,6}(\s|$)/.test(l) ? `\u200B${l}` : l)).join('\n')).filter((p) => p.trim());
}

export function applySheet(vault: string, rows: readonly Row[], out: string, opts: ApplyOptions): ApplyResult {
  const result: ApplyResult = { written: [], missing: [], unresolved: rows.filter((r) => r.include === 'check').length };
  const included = rows.filter((r) => r.include === 'yes');
  const blocks = new Map<string, Map<string, Block>>();
  const blockOf = (r: Row) => {
    if (!blocks.has(r.page)) {
      const file = path.join(vault, r.page);
      blocks.set(r.page, existsSync(file) ? new Map(splitBlocks(readFileSync(file, 'utf8')).map((b) => [b.id, b])) : new Map());
    }
    const b = blocks.get(r.page)!.get(r.block);
    if (!b) result.missing.push({ page: r.page, block: r.block, lines: r.lines });
    return b;
  };

  const wiki = new Map<string, { row: Row; block: Block }[]>();
  const book = new Map<string, { row: Row; block: Block }[]>();
  for (const row of included) {
    const block = blockOf(row);
    if (!block) continue;
    if (row.label === 'writing') {
      const dest = row.dest || defaultDest(row.page, row.heading);
      if (!ONE_SEGMENT.test(dest)) throw new Error(`dest '${dest}' (${row.page} lines ${row.lines}) must be one file name`);
      wiki.set(dest, [...(wiki.get(dest) ?? []), { row, block }]);
    }
    if (row.label === 'morning-pages' || (row.label === 'writing' && row.book)) {
      const chapter = row.book || defaultBook(row.page, row.heading);
      book.set(chapter, [...(book.get(chapter) ?? []), { row, block }]);
    }
  }
  for (const m of result.missing) log.warning(`${m.page}: block ${m.block} (lines ${m.lines}) is not in the page any more; not written`);

  const written: string[] = [];
  const write = (rel: string, text: string) => {
    const file = path.join(out, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    written.push(rel);
  };

  for (const [dest, items] of wiki) {
    const sources = items.map(({ row, block }) => `  - ${JSON.stringify(`${row.page} lines ${block.start}-${block.end} ^${block.id}`)}`);
    const groups: { key: string; heading: string; texts: string[] }[] = [];
    for (const { row, block } of items) {
      const key = `${row.page}\0${row.heading}`;
      const last = groups[groups.length - 1];
      if (last?.key === key) last.texts.push(block.text);
      else groups.push({ key, heading: row.heading || path.posix.basename(row.page, '.md'), texts: [block.text] });
    }
    const body = groups.length === 1
      ? groups[0]!.texts.join('\n\n')
      : groups.map((g) => `## ${g.heading}\n\n${g.texts.join('\n\n')}`).join('\n\n');
    write(path.join('wiki', `${dest}.md`), `---\nsources:\n${sources.join('\n')}\n---\n\n${body}\n`);
  }

  if (book.size) {
    const chapters = [...book.keys()].sort();
    const parts = ['Morning Pages'];
    for (const title of chapters) {
      parts.push(`# ${title}`);
      for (const { block } of book.get(title)!) parts.push(...bookParagraphs(block));
    }
    write('Morning Pages.md', `${parts.join('\n\n')}\n`);
  }

  const wikiFiles = written.filter((f) => f.startsWith(`wiki${path.sep}`)).sort();
  if (wikiFiles.length) {
    const prefix = opts.pathPrefix ?? out;
    const sep = prefix.includes('\\') ? '\\' : '/';
    write('import-list.txt', `${wikiFiles.map((f) => [prefix.replace(/[\\/]+$/, ''), ...f.split(path.sep)].join(sep)).join('\n')}\n`);
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
  writeFileSync(recordFile, JSON.stringify(written, null, 2));
  result.written = written;
  log.info(`wrote ${wiki.size} wiki pages and ${book.size} Morning Pages chapters; ${result.missing.length} blocks changed since review; ${result.unresolved} rows still to check`);
  return result;
}
