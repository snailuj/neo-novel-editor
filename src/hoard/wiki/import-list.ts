// An import list: which Markdown pages come into the wiki, from anywhere on the disk, so
// one import can cross the folders an OS picker cannot, and leave out the pages that are
// not writing. A text list names one page a line; `# ` lines are comments. After the
// path, `#Heading` takes only that section (a split), and ` -> Name` names the page in
// the wiki. A .csv list is a keep/move list: the rows of its `path` column whose
// `verdict` is Move.
//
// Pure: the list's text is handed in, and nothing is read from the disk.
import path from 'node:path';

export interface ListEntry {
  /** The list's line the entry is on, counting from 1. */
  line: number;
  path: string;
  /** The heading whose section is taken, or null for the whole page. */
  section: string | null;
  /** The page's name in the wiki, or null for the file's own. */
  name: string | null;
}

export interface ImportList {
  entries: ListEntry[];
  /** Rows of a keep/move list that name a page but do not move it whole. */
  left: { line: number; path: string; why: string }[];
}

/** A list that does not read as a list. */
export class ListError extends Error {
  override name = 'ListError';
}

const PAGE = /^(.*?\.md)(?:#(.*))?$/i;

function entry(line: number, text: string, dir: string): ListEntry {
  const arrow = text.indexOf('->');
  const target = (arrow < 0 ? text : text.slice(0, arrow)).trim();
  const name = arrow < 0 ? null : text.slice(arrow + 2).trim();
  if (name !== null && (name === '' || /[/\\\0]/.test(name) || name === '.' || name === '..')) {
    throw new ListError(`line ${line}: the name after -> must be one name, with no slash`);
  }
  const page = PAGE.exec(target);
  if (!page) throw new ListError(`line ${line}: a page in the list is a .md file`);
  const section = page[2]?.trim() || null;
  return { line, path: path.resolve(dir, page[1]!), section, name };
}

function readText(text: string, dir: string): ImportList {
  const entries: ListEntry[] = [];
  text.split(/\r\n?|\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    entries.push(entry(i + 1, line, dir));
  });
  return { entries, left: [] };
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
  const at = { path: columns.indexOf('path'), verdict: columns.indexOf('verdict') };
  if (at.path < 0 || at.verdict < 0) throw new ListError('line 1: a keep/move list needs a path column and a verdict column');
  const list: ImportList = { entries: [], left: [] };
  for (const { line, cells } of rows) {
    const file = (cells[at.path] ?? '').trim();
    const verdict = (cells[at.verdict] ?? '').trim();
    if (file === '') continue;
    if (verdict.toLowerCase() === 'move') list.entries.push(entry(line, file, dir));
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
