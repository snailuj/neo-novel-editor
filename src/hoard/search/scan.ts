// A search over chapters' and pages' paragraphs, the same in both halves: the worker runs it over
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

/** A page of the library's wiki/ or sources/ folder, searched by its id (`<tree>/<path>`). */
export interface PageText {
  page: string;
  /** The page's title (its file name without .html), which a search looks in. */
  title: string;
  paragraphs: readonly string[];
}

export type Text = ChapterText | PageText;

interface Place {
  kind: 'title' | 'text';
  pIdx: number;
  off: number;
  len: number;
  before: string;
  match: string;
  after: string;
}

export interface BookHit extends Place {
  bookId: string;
  chId: string;
  /** The chapter's label (its title, or its place in the book). */
  chapter: string;
}

export interface PageHit extends Place {
  /** The page's id, `<tree>/<path>`. */
  page: string;
  title: string;
}

export type Hit = BookHit | PageHit;
export type HitOf<T extends Text> = T extends PageText ? PageHit : BookHit;

export interface Found<H extends Hit = Hit> {
  /** The first `limit` hits. */
  hits: H[];
  /** How many there are, up to `cap`. */
  total: number;
  /** true when the count stopped at the cap. */
  capped: boolean;
}

export interface ScanOptions<T extends Text = Text> {
  limit: number;
  cap: number;
  /** A paragraph folded; a caller that keeps folded text hands it over here. */
  foldOf?: (item: T, pIdx: number) => Folded;
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

// Where a hit belongs: the chapter's book and id, or the page's id.
function owner(item: Text): Pick<PageHit, 'page' | 'title'> | Pick<BookHit, 'bookId' | 'chId' | 'chapter'> {
  return 'page' in item
    ? { page: item.page, title: item.title }
    : { bookId: item.bookId, chId: item.chId, chapter: item.label ?? item.title };
}

export function searchChapters<T extends Text>(items: Iterable<T>, query: string, options: ScanOptions<T>): Found<HitOf<T>> {
  const q = foldQuery(query);
  const found: Found<HitOf<T>> = { hits: [], total: 0, capped: false };
  if (!q) return found;
  const list = [...items];
  const foldOf = options.foldOf ?? ((item: T, pIdx: number) => fold(item.paragraphs[pIdx]!));
  const add = (place: Place, item: T) => {
    if (found.hits.length < options.limit) found.hits.push({ ...owner(item), ...place } as HitOf<T>);
    found.total++;
    if (found.total >= options.cap) found.capped = true;
  };

  for (const item of list) {
    if (found.capped) return found;
    if (item.title && fold(item.title).text.includes(q)) {
      add({ kind: 'title', pIdx: 0, off: 0, len: 0, before: '', match: item.title, after: '' }, item);
    }
  }
  for (const item of list) {
    for (let pIdx = 0; pIdx < item.paragraphs.length; pIdx++) {
      const text = item.paragraphs[pIdx]!;
      const folded = foldOf(item, pIdx);
      for (let a = folded.text.indexOf(q); a >= 0; a = folded.text.indexOf(q, a + q.length)) {
        if (found.capped) return found;
        const { off, len } = originalSpan(text, folded.at, a, a + q.length);
        add({ kind: 'text', pIdx, off, len, before: before(text, off), match: text.slice(off, off + len), after: after(text, off + len) }, item);
      }
    }
  }
  return found;
}
