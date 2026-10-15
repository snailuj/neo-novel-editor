// The Search section beside the book. Plugins > Search Library… opens it with the focus
// in its field, holding the words selected on the page if there are some. A search runs
// once typing pauses, from two letters: the open book here, on its paragraphs as they
// stand (which can be ahead of its file), and every other book through the main half's
// worker, from their files. Results come in groups: the wiki first, then the open book,
// then the others by title, titles that hold the phrase first in each.
//
// A result goes where it says. In the open book it selects the words. A wiki page, while
// another book is open, shows in the Wiki section beside it, at the words, so the writer
// keeps their place. Another book is opened at the words.
//
// Nothing here runs while the writer types in the manuscript.
import { fold, type Folded } from './fold.ts';
import { searchChapters, type ChapterText, type Hit } from './scan.ts';
import type { Group, LibraryFound } from './library.ts';

const WAIT_MS = 250;
const MIN_LETTERS = 2;
const LIMIT = 200;
const CAP = 1000;
const MAX_FOLDS = 50_000;

type Scope = 'all' | 'wiki' | 'book';

interface WikiSide {
  /** The wiki's book id, once known. */
  bookId(): string | null;
  /** A wiki page shown in the Wiki section, at a place on it. */
  show(chId: string, at: { pIdx: number; off: number; len: number } | null): Promise<void>;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const frames = (n: number) => new Promise<void>((resolve) => {
  const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
  next(n);
});

const count = (n: number) => n.toLocaleString('en');

// The selection on the page, when it lies in one paragraph of the manuscript.
function selectedWords(): string {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0);
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const p = start?.closest('.chapter-body p');
  if (!p || !p.contains(range.endContainer)) return '';
  return sel.toString().trim().slice(0, 80);
}

export function startSearch(neo: NeoApiV4, wiki: WikiSide) {
  const pane = neo.addPane({ id: 'search', title: 'Search', side: true });
  const root = pane.element;
  root.classList.add('hoard-search');

  const form = el('form', 'hoard-search-form');
  form.setAttribute('role', 'search');
  const fieldId = 'hoard-search-field';
  const label = el('label', 'hoard-search-label', 'Search the library');
  label.htmlFor = fieldId;
  const field = el('input', 'hoard-search-field');
  field.id = fieldId;
  field.type = 'search';
  field.autocomplete = 'off';
  field.spellcheck = false;
  const scope = el('select', 'hoard-search-scope');
  scope.setAttribute('aria-label', 'Where to search');
  for (const [value, text] of [['all', 'All Books'], ['wiki', 'Wiki'], ['book', 'This Book']] as const) {
    const option = el('option', '', text);
    option.value = value;
    scope.append(option);
  }
  form.append(label, field, scope);
  const status = el('p', 'hoard-status');
  status.setAttribute('role', 'status');
  const results = el('div', 'hoard-search-results');
  root.append(form, status, results);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = 0;
  let first: (() => void) | null = null;

  // Each paragraph folded once while its words stay the same.
  const folds = new Map<string, Folded>();
  const foldOf = (chapter: ChapterText, pIdx: number) => {
    const text = chapter.paragraphs[pIdx]!;
    let f = folds.get(text);
    if (!f) {
      if (folds.size > MAX_FOLDS) folds.clear();
      f = fold(text);
      folds.set(text, f);
    }
    return f;
  };

  // The open book's group, from its paragraphs as they stand.
  const openGroup = (text: string): Group | null => {
    const book = neo.book();
    if (!book) return null;
    const titles = (book['chapterTitles'] ?? {}) as Record<string, string>;
    const chapters: ChapterText[] = [];
    book.chapterOrder.forEach((chId, n) => {
      const chapter = neo.chapter(chId);
      if (!chapter) return;
      const title = titles[chId] ?? '';
      chapters.push({ bookId: book.id, chId, title, label: title || `Chapter ${n + 1}`, paragraphs: chapter.paragraphs });
    });
    const found = searchChapters(chapters, text, { limit: LIMIT, cap: CAP, foldOf });
    return found.total ? { bookId: book.id, bookTitle: book.title || 'This book', wiki: book.id === wiki.bookId(), hits: found.hits, total: found.total } : null;
  };

  const go = async (hit: Hit) => {
    const at = hit.kind === 'title' ? { pIdx: 0, off: 0, len: 0 } : { pIdx: hit.pIdx, off: hit.off, len: hit.len };
    const place = { chId: hit.chId, ...at };
    const book = neo.book();
    if (book && book.id === hit.bookId) {
      if (!neo.go(place)) status.textContent = 'Those words have changed since the search. Search again to find them.';
      return;
    }
    if (hit.bookId === wiki.bookId()) {
      await wiki.show(hit.chId, hit.kind === 'title' ? null : at);
      return;
    }
    if (!(await neo.open(hit.bookId))) {
      status.textContent = 'That book could not be opened.';
      return;
    }
    // the book takes the writer back to where they last were a frame after it opens
    await frames(2);
    if (!neo.go(place)) status.textContent = 'Those words have changed since the search. Search again to find them.';
  };

  const hitButton = (hit: Hit) => {
    const b = el('button', 'hoard-search-hit');
    b.type = 'button';
    b.append(el('span', 'hoard-search-where', hit.kind === 'title' ? `${hit.chapter} (title)` : hit.chapter));
    const words = el('span', 'hoard-search-words');
    words.append(
      document.createTextNode(hit.before && hit.before.length < hit.off ? `…${hit.before}` : hit.before),
      el('mark', '', hit.match),
      document.createTextNode(hit.after),
    );
    if (hit.kind === 'text') b.append(words);
    b.addEventListener('click', () => { go(hit).catch((err: unknown) => { status.textContent = `That result could not be opened: ${String(err)}`; }); });
    return b;
  };

  const draw = (groups: Group[]) => {
    first = null;
    results.replaceChildren(...groups.map((group) => {
      const section = el('section', 'hoard-search-group');
      const open = neo.book()?.id === group.bookId;
      section.append(el('h4', 'hoard-search-book', `${group.bookTitle}${open ? ' (open)' : ''} · ${count(group.total)}`));
      const list = el('ul', 'hoard-search-list');
      for (const hit of group.hits) {
        const item = el('li');
        const b = hitButton(hit);
        first ??= () => b.click();
        item.append(b);
        list.append(item);
      }
      section.append(list);
      return section;
    }));
  };

  const where = (s: Scope) => (s === 'all' ? 'any book' : s === 'wiki' ? 'the wiki' : 'this book');

  const run = async (): Promise<void> => {
    clearTimeout(timer);
    const text = field.value.trim();
    const s = scope.value as Scope;
    const mine = ++asked;
    if ([...text].length < MIN_LETTERS) {
      draw([]);
      status.textContent = text ? 'Type two letters or more.' : 'Type words to find them in your books and the wiki.';
      return;
    }
    const book = neo.book();
    if (!book) {
      draw([]);
      status.textContent = 'Open a book to search.';
      return;
    }
    const openIsWiki = book.id === wiki.bookId();
    const live = s === 'book' || s === 'all' || (s === 'wiki' && openIsWiki) ? openGroup(text) : null;
    let found: LibraryFound | null = null;
    let failed = '';
    if (s !== 'book') {
      status.textContent = 'Searching…';
      try {
        found = (await neo.invoke('search.query', {
          text, scope: s, open: book.id, limit: Math.max(1, LIMIT - (live?.hits.length ?? 0)), cap: CAP,
        })) as LibraryFound;
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
      }
    }
    if (mine !== asked) return;
    const others = found?.groups ?? [];
    const groups = [...others.filter((g) => g.wiki), ...(live ? [live] : []), ...others.filter((g) => !g.wiki)];
    draw(groups);
    const total = groups.reduce((n, g) => n + g.total, 0);
    const shown = groups.reduce((n, g) => n + g.hits.length, 0);
    const capped = (found?.capped ?? false) || total >= CAP;
    const lines: string[] = [];
    if (total === 0) lines.push(`Nothing in ${where(s)} has “${text}”.`);
    else {
      lines.push(`${capped ? `${count(CAP)} or more` : count(total)} match${total === 1 ? '' : 'es'} in ${groups.length} book${groups.length === 1 ? '' : 's'}.`);
      if (shown < total) lines.push(`The first ${count(shown)} are shown.`);
    }
    if (found?.cloud) lines.push(`${count(found.cloud)} file${found.cloud === 1 ? ' is' : 's are'} in iCloud and not on this computer yet, so not searched.`);
    if (found?.unreadable) lines.push(`${count(found.unreadable)} book${found.unreadable === 1 ? '' : 's'} could not be read.`);
    if (failed) lines.push(`Other books were not searched: ${failed}`);
    status.textContent = lines.join(' ');
  };

  field.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { run(); }, WAIT_MS);
  });
  scope.addEventListener('change', () => { run(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await run();
    first?.();
  });
  field.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const b = results.querySelector<HTMLButtonElement>('.hoard-search-hit');
    if (!b) return;
    e.preventDefault();
    b.focus();
  });
  status.textContent = 'Type words to find them in your books and the wiki.';

  const open = (preset = '') => {
    if (!pane.show()) return false;
    if (preset) field.value = preset;
    field.focus();
    field.select();
    if (field.value.trim()) run();
    return true;
  };

  neo.addCommand('search-library', () => {
    if (!open(selectedWords())) neo.status('Open a book to search.');
  });

  return { open, run, field, scope };
}
