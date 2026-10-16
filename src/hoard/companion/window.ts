// The librarian's watcher in the window. It keeps, for each chapter the writer saves, the
// chapter as it was at its first save here (`previous`) and as last saved, and hands both
// to the main half at every save (snailuj, 16 October: comments at each save, with Show
// or Hide Comments to keep them off the page). While the writer is still in the chapter
// the caret goes along, and a name it is in or just after is left alone, as the word may
// not be finished. Leaving the chapter (the caret moves into another, or the book closes)
// hands it over a last time without the caret, and forgets it. One read per chapter is
// out at a time; saves meanwhile are folded into one more read when it answers.
//
// Stop Flagging This Page and Flag This Page Again act on the librarian's comment at the
// caret, or the one picked in the Comments section.
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { reported } from './finding.ts';
import type { WikiPage } from './mentions.ts';

const STATUS_MS = 4_000;

interface Pending {
  bookId: string;
  chId: string;
  before: string;
  after: string;
  /** A read is out for this chapter; `again` asks for one more when it answers. */
  out: boolean;
  again: boolean;
}

interface MarksView {
  state(): { bookId: string | null; marks: Record<string, Mark[]>; active: string | null; here: { chId: string } | null };
  relist(): Promise<void>;
}

export function startCompanion(neo: NeoApiV4, o: {
  marks: MarksView;
  wiki: () => { bookId: string; pages: { chId: string; title: string }[] } | null;
}) {
  const pending = new Map<string, Pending>();
  let here: string | null = null;
  // the caret's paragraph and offset in the chapter it is in
  let caret: { pIdx: number; off: number } | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const reading = new Set<Promise<unknown>>();

  const say = (text: string) => {
    neo.status(text);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => neo.status(''), STATUS_MS);
  };

  // Hands a chapter to the main half: with the caret while the writer is in it, and for
  // the last time once they have left.
  const send = (k: string) => {
    const p = pending.get(k);
    if (!p) return;
    if (p.out) { p.again = true; return; }
    const left = k !== here;
    if (left) pending.delete(k);
    p.out = true;
    p.again = false;
    const req = { bookId: p.bookId, chId: p.chId, before: p.before, after: p.after, caret: left ? null : caret };
    const run = (neo.invoke('companion.read', req) as Promise<{ added: number }>)
      .then(async ({ added }) => { if (added > 0) await o.marks.relist(); })
      .catch((err: unknown) => console.debug('hoard: companion.read', err))
      .finally(() => {
        reading.delete(run);
        p.out = false;
        // a save, or the writer leaving, while it was out
        if (p.again && pending.get(k) === p) send(k);
      });
    reading.add(run);
  };

  const sendLeft = () => {
    for (const k of [...pending.keys()]) if (k !== here) send(k);
  };

  neo.on('chapter-saved', ({ bookId, chId, html, previous }) => {
    if (bookId === o.wiki()?.bookId) return;
    const k = `${bookId}/${chId}`;
    const known = pending.get(k);
    if (known) known.after = html;
    else pending.set(k, { bookId, chId, before: previous ?? '', after: html, out: false, again: false });
    send(k);
  });
  neo.on('selection', ({ place }) => {
    const book = neo.book();
    if (!place || !book) return;
    caret = { pIdx: place.pIdx, off: place.off + place.len };
    const k = `${book.id}/${place.chId}`;
    if (k === here) return;
    here = k;
    sendLeft();
  });
  neo.on('book-open', () => { here = null; caret = null; });
  neo.on('book-close', () => {
    here = null;
    caret = null;
    sendLeft();
  });

  // The librarian's finding at the caret, or picked in the Comments section, and its page.
  const finding = (): { bookId: string; chId: string; mark: Mark; page: { chId: string; title: string } } | null => {
    const { bookId, marks, active, here: at } = o.marks.state();
    const wiki = o.wiki();
    const mark = active && at ? marks[at.chId]?.find((m) => m.id === active) : undefined;
    if (!bookId || !at || !mark || !wiki) return null;
    const pages: WikiPage[] = wiki.pages.map((p) => ({ id: p.chId, title: p.title, aliases: [], pantsing: false }));
    const [id] = reported([mark], pages);
    const page = id ? wiki.pages.find((p) => p.chId === id) : undefined;
    return page ? { bookId, chId: at.chId, mark, page } : null;
  };

  const quiet = async (on: boolean) => {
    const found = finding();
    if (!found) {
      say(`Put the caret in one of the librarian's comments on a page, or pick it in the Comments section, then choose ${on ? 'Stop Flagging This Page' : 'Flag This Page Again'}.`);
      return;
    }
    const { bookId, chId, mark, page } = found;
    try {
      await neo.invoke('companion.quiet', { page: page.chId, quiet: on });
      if (on && mark.state === 'open') {
        await neo.invoke('marks.state', { bookId, chId, markId: mark.id, state: 'resolved' });
        await o.marks.relist();
      }
      say(on
        ? `The librarian will stop flagging “${page.title}”. Flag This Page Again undoes it.`
        : `The librarian will flag “${page.title}” in new writing again.`);
    } catch (err) {
      say(`Nothing changed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  neo.addCommand('stop-flagging', () => quiet(true));
  neo.addCommand('flag-again', () => quiet(false));

  return {
    /** For tests: resolves once every read handed over so far has answered. */
    settled: async () => { while (reading.size) await Promise.all([...reading]); },
    /** For tests and the console: the chapters waiting to be read. */
    pending: () => [...pending.keys()],
  };
}
