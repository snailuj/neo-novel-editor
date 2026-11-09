// An import list: which Markdown pages come into the library, from anywhere on the disk,
// so one import can cross the folders an OS picker cannot, and leave out the pages that
// are not writing. A text list names one page a line; `# ` lines are comments. After the
// path, `#Heading` takes only that section (a split), `#L12-L40` only those lines (with
// `@` and the start of the file's SHA-256 after it, so lines that moved are refused),
// and ` -> Name` names the page; ` -> Folder/Name` also puts it in that folder of its tree.
//
// Each page goes to one of the library's two trees of pages, sources/ (the default) or
// wiki/: a `to: wiki` line sends the entries after it to the wiki, and `to: sources`
// back. A .csv list is a keep/move list: the rows of its `path` column whose `verdict` is
// Move, named by a `name` column, sent to a `to` column's tree where it has one.
//
// An `images from: <folder>` line, anywhere in a text list, names a further folder where
// every page of the list looks for the images and PDFs its own vault lacks.
//
// Pure: the list's text is handed in, and nothing is read from the disk.
import path from 'node:path';
import type { Tree } from '../pages/identity.ts';

export interface ListEntry {
  /** The list's line the entry is on, counting from 1. */
  line: number;
  path: string;
  /** The heading whose section is taken, or null for the whole page. */
  section: string | null;
  /** The page's name, or null for the file's own. */
  name: string | null;
  /** The folder of its tree the page goes in, `/` between folders, or null for the default. */
  folder: string | null;
  /** The tree the page goes to. */
  to: Tree;
  /** The start of the file's SHA-256 that a line range was read against, or null. */
  sha: string | null;
  /** Further folders to find attachments in: the list's, shared by every entry. */
  lookIn: string[];
}

export interface ImportList {
  entries: ListEntry[];
  /** Rows of a keep/move list that name a page but do not move it whole. */
  left: { line: number; path: string; why: string }[];
  /** Further folders to find attachments in, from `images from:` lines. */
  lookIn: string[];
}

/** A list that does not read as a list. */
export class ListError extends Error {
  override name = 'ListError';
}

const PAGE = /^(.*?\.md)(?:#(.*))?$/i;
const LINES = /^L(\d+)-L(\d+)(?:@([0-9a-f]{8,64}))?$/i;
const TO = /^to:(.*)$/i;
const IMAGES = /^images from:(.*)$/i;

const SOURCES: Tree = 'sources';

/** True for a section that names a line range, `L12-L40`, rather than a heading. */
export function lineRange(section: string): { start: number; end: number } | null {
  const m = /^L(\d+)-L(\d+)$/.exec(section);
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

function oneTitle(line: number, what: string, title: string): string {
  if (title === '' || /[/\\\0]/.test(title) || title === '.' || title === '..') {
    throw new ListError(`line ${line}: the ${what} must be one name, with no slash`);
  }
  return title;
}

function treeOf(line: number, word: string): Tree {
  const t = word.trim().toLowerCase();
  if (t !== 'sources' && t !== 'wiki') throw new ListError(`line ${line}: a page goes to sources or wiki, not "${word.trim()}"`);
  return t;
}

// `Folder/Sub/Name`: the name, and the folders before it, each one name a page path can hold.
function placed(line: number, text: string): { name: string; folder: string | null } {
  const parts = text.split('/').map((p) => p.trim());
  const name = oneTitle(line, 'name after ->', parts.pop()!);
  if (!parts.length) return { name, folder: null };
  for (const p of parts) {
    if (p === '' || p.startsWith('.') || /[\\\0]/.test(p)) throw new ListError(`line ${line}: "${p}" cannot be a folder: it is empty, starts with a dot, or holds a backslash`);
  }
  return { name, folder: parts.join('/') };
}

function entry(line: number, text: string, dir: string, dest: Tree = SOURCES, lookIn: string[] = []): ListEntry {
  const arrow = text.indexOf('->');
  const target = (arrow < 0 ? text : text.slice(0, arrow)).trim();
  const { name, folder } = arrow < 0 ? { name: null, folder: null } : placed(line, text.slice(arrow + 2));
  const page = PAGE.exec(target);
  if (!page) throw new ListError(`line ${line}: a page in the list is a .md file`);
  let section = page[2]?.trim() || null;
  let sha: string | null = null;
  const lines = section ? LINES.exec(section) : null;
  if (lines) {
    const [start, end] = [Number(lines[1]), Number(lines[2])];
    if (start < 1 || end < start) throw new ListError(`line ${line}: lines L${start}-L${end} run backwards or from before line 1`);
    section = `L${start}-L${end}`;
    sha = lines[3]?.toLowerCase() ?? null;
  }
  return { line, path: path.resolve(dir, page[1]!), section, name, folder, to: dest, sha, lookIn };
}

function readText(text: string, dir: string): ImportList {
  const entries: ListEntry[] = [];
  const lookIn: string[] = [];
  let dest = SOURCES;
  text.split(/\r\n?|\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const to = TO.exec(line);
    const images = IMAGES.exec(line);
    if (to) dest = treeOf(i + 1, to[1]!);
    else if (images) {
      const folder = images[1]!.trim();
      if (!folder) throw new ListError(`line ${i + 1}: "images from:" needs a folder after it`);
      lookIn.push(path.resolve(dir, folder));
    }
    else entries.push(entry(i + 1, line, dir, dest, lookIn));
  });
  return { entries, left: [], lookIn };
}

// RFC 4180 rows, each with the line it starts on. A quote doubles inside a quoted field.
function csvRows(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; cell += ch; }
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push({ line: start, cells });
      cells = [];
      cell = '';
      start = ++line;
    } else cell += ch;
  }
  if (quoted) throw new ListError(`line ${start}: a quoted field is never closed`);
  if (cell !== '' || cells.length) rows.push({ line: start, cells: [...cells, cell] });
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

function readCsv(text: string, dir: string): ImportList {
  const [head, ...rows] = csvRows(text);
  const columns = (head?.cells ?? []).map((c) => c.trim().toLowerCase());
  const at = {
    path: columns.indexOf('path'), verdict: columns.indexOf('verdict'), name: columns.indexOf('name'), to: columns.indexOf('to'),
  };
  if (at.path < 0 || at.verdict < 0) throw new ListError('line 1: a keep/move list needs a path column and a verdict column');
  const list: ImportList = { entries: [], left: [], lookIn: [] };
  for (const { line, cells } of rows) {
    const file = (cells[at.path] ?? '').trim();
    const verdict = (cells[at.verdict] ?? '').trim();
    if (file === '') continue;
    if (verdict.toLowerCase() === 'move') {
      const name = at.name < 0 ? '' : (cells[at.name] ?? '').trim();
      const to = at.to < 0 ? '' : (cells[at.to] ?? '').trim();
      const dest = to ? treeOf(line, to) : SOURCES;
      list.entries.push(entry(line, name ? `${file} -> ${name}` : file, dir, dest));
    }
    else if (verdict.toLowerCase() === 'split') list.left.push({ line, path: file, why: 'its verdict is Split: name its sections in a text list' });
    else if (verdict.toLowerCase() !== 'keep') list.left.push({ line, path: file, why: `its verdict is ${verdict || 'empty'}` });
  }
  return list;
}

/** The pages a list names. Throws ListError for a list that does not read, or names none. */
export function readImportList(file: string, text: string): ImportList {
  const dir = path.dirname(path.resolve(file));
  const body = text.replace(/^﻿/, '');
  const list = /\.csv$/i.test(file) ? readCsv(body, dir) : readText(body, dir);
  if (list.entries.length === 0 && list.left.length === 0) throw new ListError('the list names no page');
  return list;
}
