// The review sheet: one CSV row per block, so the author can correct the classifier
// before anything is imported. `proposed` is the classifier's label and stays as it was;
// the rest is the author's to edit. A block has two possible homes: `wiki` (yes, no or
// check) sends it to the wiki page `wiki_page`; a `book` value sends it to that chapter
// of the Morning Pages book. A Morning Pages section goes to the book whole, whatever its
// blocks' labels, so the journal keeps each day as written. `entry` and `topic` come from
// the group command: the entry a block belongs to and what that entry is about. A re-run
// keeps every row it already has (matched by page and block id) and only adds new blocks.
import path from 'node:path';
import type { Judged } from './judge.ts';
import { fallbackGuess, type Label, MORNING_PAGES, ruleLabel } from './rules.ts';
import type { Block } from './split.ts';

export const COLUMNS = ['page', 'block', 'lines', 'heading', 'proposed', 'label', 'wiki', 'wiki_page', 'book', 'topic', 'entry', 'topic_by', 'pasted', 'by', 'reason', 'preview'] as const;
/** Columns added after the first sheets were written; a sheet without them reads them as empty. */
const LATER: readonly string[] = ['topic', 'entry', 'topic_by'];
export type Row = Record<(typeof COLUMNS)[number], string>;

export interface Already {
  /** The page's path with forward slashes, as written in the list. */
  path: string;
  section: string | null;
  name: string | null;
}

/** An import list's lines: `path`, `path#Section` and either with ` -> Name`; `#` starts a comment. */
export function parseAlready(text: string): Already[] {
  const out: Already[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const arrow = line.indexOf(' -> ');
    const target = (arrow >= 0 ? line.slice(0, arrow) : line).trim().replace(/\\/g, '/');
    const name = arrow >= 0 ? line.slice(arrow + 4).trim() : null;
    const hash = target.indexOf('.md#');
    out.push(hash >= 0
      ? { path: target.slice(0, hash + 3), section: target.slice(hash + 4), name }
      : { path: target, section: null, name });
  }
  return out;
}

/** Whether a list path names this vault-relative page: equal, or ending in `/page`. */
const samePage = (listed: string, page: string) => listed === page || listed.endsWith(`/${page}`);

function alreadyFor(page: string, block: Block, list: readonly Already[]): Already | null {
  for (const a of list) {
    if (!samePage(a.path, page)) continue;
    if (a.section === null || block.heading.includes(a.section)) return a;
  }
  return null;
}

const stemOf = (page: string) => path.posix.basename(page.replace(/\\/g, '/')).replace(/\.md$/i, '');
const safe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').trim().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
const DATE = /\d{4}-\d{2}-\d{2}/;

/** The default wiki page for a writing block: its page (a daily note by its date alone) and innermost heading. */
export function defaultDest(page: string, heading: string): string {
  const inner = heading.split(' > ').pop() ?? '';
  const stem = stemOf(page);
  const name = safe(/^\d{4}-\d{2}-\d{2}\b/.exec(stem)?.[0] ?? stem);
  // A heading that repeats the page's name ("## 2025-09-13", "Habit Tracking 2025-09-13") says it once.
  const head = safe(inner).split(name).join('-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return `${[name, head].filter(Boolean).join('-')}-(snippets)`;
}

/**
 * Leaves one wiki copy of each text: a fresh row bound for the wiki whose text an earlier
 * one already carries (a generated line repeated across daily notes) is set to no.
 * Rows an earlier run made are never changed, so a reviewed sheet stays as reviewed.
 */
export function dedupeRows(rows: Row[], isFresh: (row: Row) => boolean): number {
  const first = new Map<string, Row>();
  let changed = 0;
  for (const r of rows) {
    if (r.wiki !== 'yes') continue;
    const hash = r.block.replace(/-\d+$/, '');
    const earlier = first.get(hash);
    if (!earlier) {
      first.set(hash, r);
      continue;
    }
    if (!isFresh(r)) continue;
    r.wiki = 'no';
    r.reason = `same text as ${earlier.page} lines ${earlier.lines}; ${r.reason}`;
    changed++;
  }
  return changed;
}

/** The wiki page for the writing of a topic that several entries share. */
export const topicDest = (topic: string) => `${safe(topic)}-(snippets)`;

/** The default Morning Pages chapter: the page's date, else a heading's, else the page. */
export function defaultBook(page: string, heading: string): string {
  const stem = stemOf(page);
  return DATE.exec(stem)?.[0] ?? heading.split(' > ').map((h) => DATE.exec(h)?.[0]).find(Boolean) ?? stem;
}

const preview = (text: string) => {
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
};

export function rowsFor(page: string, blocks: readonly Block[], judged: ReadonlyMap<string, Judged>, already: readonly Already[]): Row[] {
  return blocks.map((b) => {
    const heading = b.heading.join(' > ');
    const ruled = ruleLabel(b);
    const j = judged.get(b.id);
    const label: Label = ruled?.label ?? j?.label ?? fallbackGuess(b);
    const by = ruled ? 'rule' : j?.by ?? 'no-judge';
    const pasted = !ruled && j?.pasted === true;
    let reason = ruled?.reason ?? j?.reason ?? 'not judged';
    const said = (l: Label) => label === l || (j?.votes ?? []).includes(l);
    // Unsure means the author decides: no judge, a failed one, or votes of which one says writing.
    let wiki = ruled ? 'no'
      : by === 'judge' ? (label === 'writing' && !pasted ? 'yes' : 'no')
      : by === 'votes-differ' ? (said('writing') ? 'check' : 'no')
      : 'check';
    const inMorningPages = b.heading.some((h) => MORNING_PAGES.test(h));
    let wikiPage = wiki !== 'no' || label === 'writing' ? defaultDest(page, heading) : '';
    const book = !ruled && (inMorningPages || said('morning-pages')) ? defaultBook(page, heading) : '';
    const done = alreadyFor(page, b, already);
    if (done && !ruled) {
      wiki = 'no';
      reason = `already imported as ${done.name ?? stemOf(done.path)}; ${reason}`;
      if (label === 'writing') wikiPage = done.name ?? stemOf(done.path);
    }
    return {
      page, block: b.id, lines: `${b.start}-${b.end}`, heading,
      proposed: label, label, wiki, wiki_page: wikiPage, book, topic: '', entry: '', topic_by: '',
      pasted: pasted ? 'yes' : 'no', by, reason, preview: preview(b.text),
    };
  });
}

/** Fresh rows in order, each replaced by the old row for the same block when there is one. */
export function mergeRows(old: readonly Row[], fresh: readonly Row[]): Row[] {
  const byKey = new Map(old.map((r) => [`${r.page}\0${r.block}`, r]));
  return fresh.map((r) => {
    const kept = byKey.get(`${r.page}\0${r.block}`);
    return kept ? { ...kept, lines: r.lines, heading: r.heading, preview: r.preview } : r;
  });
}

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function writeSheet(rows: readonly Row[]): string {
  return `﻿${[COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join('\n')}\n`;
}

/** RFC 4180 rows; the header names the columns, so a sheet with them reordered reads too. */
export function readSheet(text: string): Row[] {
  const records: string[][] = [];
  let rec: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      // A cell's line breaks read as \n, whichever kind the editor saved.
      else if (!(ch === '\r' && src[i + 1] === '\n')) field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      rec.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      rec.push(field);
      records.push(rec);
      rec = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || rec.length) {
    rec.push(field);
    records.push(rec);
  }
  const [header, ...body] = records.filter((r) => r.some((f) => f !== ''));
  if (!header) return [];
  for (const c of COLUMNS) if (!header.includes(c) && !LATER.includes(c)) throw new Error(`the sheet has no '${c}' column`);
  return body.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[header.indexOf(c)] ?? ''])) as Row);
}
