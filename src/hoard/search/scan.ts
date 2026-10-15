// A search over chapters' paragraphs, the same in both halves: the worker runs it over
// the library's files and the window over the open book's paragraphs as they stand.
// Titles that hold the phrase come first, then each match in the order the chapters are
// given, without overlaps; a phrase never runs from one paragraph into the next. Each
// hit is a place on the words as written (fold.ts maps the folded match back), with a
// little of the paragraph either side, cut at a word, for the results list.
//
// Pure.
import { fold, foldQuery, originalSpan, type Folded } from './fold.ts';

export interface ChapterText {
  bookId: string;
  chId: string;
  /** The chapter's own title, which a search looks in; '' for none. */
  title: string;
  /** What the results list calls it: its title, or its place in the book. */
  label?: string;
  paragraphs: readonly string[];
}

export interface Hit {
  kind: 'title' | 'text';
  bookId: string;
  chId: string;
  /** The chapter's label (its title, or its place in the book). */
  chapter: string;
  pIdx: number;
  off: number;
  len: number;
  before: string;
  match: string;
  after: string;
}

export interface Found {
  /** The first `limit` hits. */
  hits: Hit[];
  /** How many there are, up to `cap`. */
  total: number;
  /** true when the count stopped at the cap. */
  capped: boolean;
}

export interface ScanOptions {
  limit: number;
  cap: number;
  /** A paragraph folded; a caller that keeps folded text hands it over here. */
  foldOf?: (chapter: ChapterText, pIdx: number) => Folded;
}

const BEFORE = 40;
const AFTER = 60;

function before(text: string, off: number): string {
  if (off <= BEFORE) return text.slice(0, off);
  const cut = text.slice(off - BEFORE, off);
  const space = cut.search(/\s\S/);
  return space >= 0 ? cut.slice(space + 1) : cut;
}

function after(text: string, end: number): string {
  if (text.length - end <= AFTER) return text.slice(end);
  const cut = text.slice(end, end + AFTER);
  const space = cut.search(/\S\s\S*$/);
  return space >= 0 ? cut.slice(0, space + 1) : cut;
}

export function searchChapters(chapters: Iterable<ChapterText>, query: string, options: ScanOptions): Found {
  const q = foldQuery(query);
  const found: Found = { hits: [], total: 0, capped: false };
  if (!q) return found;
  const list = [...chapters];
  const foldOf = options.foldOf ?? ((chapter: ChapterText, pIdx: number) => fold(chapter.paragraphs[pIdx]!));
  const add = (hit: Hit) => {
    if (found.hits.length < options.limit) found.hits.push(hit);
    found.total++;
    if (found.total >= options.cap) found.capped = true;
  };

  for (const chapter of list) {
    if (found.capped) return found;
    if (chapter.title && fold(chapter.title).text.includes(q)) {
      add({ kind: 'title', bookId: chapter.bookId, chId: chapter.chId, chapter: chapter.label ?? chapter.title, pIdx: 0, off: 0, len: 0, before: '', match: chapter.title, after: '' });
    }
  }
  for (const chapter of list) {
    for (let pIdx = 0; pIdx < chapter.paragraphs.length; pIdx++) {
      const text = chapter.paragraphs[pIdx]!;
      const folded = foldOf(chapter, pIdx);
      for (let a = folded.text.indexOf(q); a >= 0; a = folded.text.indexOf(q, a + q.length)) {
        if (found.capped) return found;
        const { off, len } = originalSpan(text, folded.at, a, a + q.length);
        add({
          kind: 'text', bookId: chapter.bookId, chId: chapter.chId, chapter: chapter.label ?? chapter.title, pIdx, off, len,
          before: before(text, off), match: text.slice(off, off + len), after: after(text, off + len),
        });
      }
    }
  }
  return found;
}
