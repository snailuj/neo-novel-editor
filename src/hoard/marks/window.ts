// The writer's marks in the window: highlights on the page and a Comments section in the
// right-hand pane beside the manuscript. The section lists the marks of the chapter the
// caret is in, each with its thread, a reply box and Resolve or Reopen, and names who
// last wrote the caret's paragraph, from git blame.
//
// Nothing here interrupts typing. A caret move never opens the section or moves the
// focus; it only marks the mark under the caret as the active one. The section opens
// when the writer asks (Add Comment, from the Plugins menu or its own button), and a
// redraw never rebuilds a box the writer is typing in. Every write goes through the main
// half, which answers with the chapter's marks as the file now holds them.
import type { Mark, MarkState } from '../../generated/hoard-marks-v1.js';
import { alignBlame } from '../git/align.ts';
import type { BlameLine } from '../git/blame.ts';
import { anchorAt } from './anchor.ts';
import { drawChapter, markAt, NAMES, orderForList, type Drawn, type Place } from './view.ts';

interface Listed { chapters: Record<string, Mark[]>; unreadable: string[] }
interface Composing { place: Place; anchor: Omit<Mark['anchor'], 'commit'> }
interface Item {
  root: HTMLDivElement;
  quote: HTMLButtonElement;
  thread: HTMLDivElement;
  shown: string;
  reply: HTMLTextAreaElement;
  stateButton: HTMLButtonElement;
}

const REDRAW_MS = 300;
const BLAME_EVERY_MS = 15_000;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const when = (at: string | number) => new Date(at).toLocaleString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const who = (w: string) => (w === 'librarian' ? 'Librarian' : 'You');
const clip = (text: string, n = 140) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const submitKey = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

export function startMarks(neo: NeoApiV3) {
  const pane = neo.addPane({ id: 'comments', title: 'Comments', side: true });
  let bookId: string | null = null;
  let marks: Record<string, Mark[]> = {};
  let unreadable = new Set<string>();
  const drawn = new Map<string, Drawn>();
  let here: Place | null = null;
  let active: string | null = null;
  let composing: Composing | null = null;
  const pending = new Set<string>();
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  const blame = new Map<string, { at: number; lines: BlameLine[] }>();
  let blameTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- the section's parts, made once --------------------------------------------
  const root = pane.element;
  root.classList.add('hoard-marks');
  const head = el('div', 'hoard-marks-head');
  const blameLine = el('p', 'hoard-blame');
  const addButton = el('button', 'hoard-add', 'Add comment');
  addButton.type = 'button';
  head.append(blameLine, addButton);
  const note = el('p', 'hoard-note');
  const composer = el('div', 'sticky hoard-composer');
  const composerQuote = el('div', 's-ch');
  const composerText = el('textarea');
  composerText.placeholder = 'Comment… (Ctrl+Enter to add, Esc to cancel)';
  const composerActions = el('div', 's-actions');
  const composeAdd = el('button', '', 'Add');
  const composeCancel = el('button', '', 'Cancel');
  composerActions.append(composeAdd, el('span', 's-sep', '·'), composeCancel);
  composer.append(composerQuote, composerText, composerActions);
  composer.hidden = true;
  const list = el('div', 'hoard-list');
  const empty = el('p', 'stickies-empty hoard-empty', 'No comments in this chapter.');
  root.append(head, note, composer, list, empty);
  const items = new Map<string, Item>();

  const say = (text: string) => {
    note.textContent = text;
    note.hidden = !text;
  };
  say('');

  // ---- drawing -------------------------------------------------------------------
  const redraw = (chId: string) => {
    const paragraphs = neo.chapter(chId)?.paragraphs;
    if (!paragraphs || !marks[chId]) drawn.delete(chId);
    else drawn.set(chId, drawChapter(chId, marks[chId], paragraphs));
  };

  const paint = () => {
    for (const name of NAMES) neo.highlight(name, [...drawn.values()].flatMap((d) => d.places[name]));
    const span = active && here ? drawn.get(here.chId)?.found.get(active) : null;
    neo.highlight('active', span && here ? [{ chId: here.chId, ...span }] : []);
  };

  const redrawAll = () => {
    drawn.clear();
    for (const chId of Object.keys(marks)) redraw(chId);
    paint();
    render();
  };

  // ---- the list ------------------------------------------------------------------
  const itemFor = (mark: Mark): Item => {
    const known = items.get(mark.id);
    if (known) return known;
    const itemRoot = el('div', 'sticky hoard-mark');
    itemRoot.dataset.mark = mark.id;
    const quote = el('button', 's-ch hoard-quote');
    quote.type = 'button';
    quote.addEventListener('click', () => goTo(mark.id));
    const thread = el('div', 'hoard-thread');
    const reply = el('textarea', 'hoard-reply');
    reply.placeholder = 'Reply… (Ctrl+Enter)';
    const actions = el('div', 's-actions');
    const replyButton = el('button', '', 'Reply');
    replyButton.type = 'button';
    const stateButton = el('button');
    stateButton.type = 'button';
    actions.append(replyButton, el('span', 's-sep', '·'), stateButton);
    itemRoot.append(quote, thread, reply, actions);
    const send = () => sendReply(mark.id, reply);
    replyButton.addEventListener('click', send);
    reply.addEventListener('keydown', (e) => {
      if (submitKey(e)) { e.preventDefault(); send(); }
      if (e.key === 'Escape') { e.preventDefault(); reply.value = ''; reply.blur(); }
    });
    stateButton.addEventListener('click', () => {
      const now = currentMark(mark.id);
      if (now) changeState(mark.id, now.state === 'resolved' ? 'open' : 'resolved');
    });
    const item: Item = { root: itemRoot, quote, thread, shown: '', reply, stateButton };
    items.set(mark.id, item);
    return item;
  };

  const fill = (item: Item, mark: Mark, stale: boolean) => {
    const closed = mark.state !== 'open' && mark.state !== 'flagged';
    item.root.classList.toggle('stale', stale);
    item.root.classList.toggle('resolved', closed);
    item.root.classList.toggle('active', mark.id === active);
    item.quote.textContent = `${stale ? 'Quote not found: ' : ''}“${clip(mark.anchor.exact)}”${closed ? ` · ${mark.state}` : ''}`;
    item.quote.disabled = stale;
    const shown = mark.thread.map((e) => e.id).join(' ');
    if (shown !== item.shown) {
      item.thread.replaceChildren(...mark.thread.map((entry) => {
        const p = el('p', 'hoard-entry');
        p.append(el('span', 'hoard-who', `${who(entry.who)} · ${when(entry.at)}`), el('span', 'hoard-body', entry.body));
        return p;
      }));
      item.shown = shown;
    }
    item.stateButton.textContent = mark.state === 'resolved' ? 'Reopen' : 'Resolve';
    item.stateButton.hidden = mark.kind !== 'comment' && mark.kind !== 'highlight';
  };

  function render() {
    const chId = here?.chId ?? null;
    const chapterMarks = chId ? marks[chId] ?? [] : [];
    const d = chId ? drawn.get(chId) : undefined;
    const ordered = d ? orderForList(chapterMarks, d) : chapterMarks;
    const wanted = ordered.map((mark) => {
      const item = itemFor(mark);
      fill(item, mark, d ? d.stale.includes(mark.id) : false);
      return item.root;
    });
    for (const [id, item] of items) {
      if (!ordered.some((m) => m.id === id)) { item.root.remove(); items.delete(id); }
    }
    // moving a box that holds the focus would take the focus from it: reorder only when
    // the order really changed
    const now = [...list.children];
    if (now.length !== wanted.length || now.some((node, i) => node !== wanted[i])) list.replaceChildren(...wanted);
    empty.hidden = wanted.length > 0 || !bookId;
    if (chId && unreadable.has(chId)) say('This chapter\'s comments file could not be read; see neo-errors.log. It is left as it is.');
    renderBlame();
  }

  const currentMark = (id: string) => (here ? marks[here.chId]?.find((m) => m.id === id) : undefined);

  // ---- who wrote the caret's paragraph ----------------------------------------------
  function renderBlame() {
    const known = here && blame.get(here.chId);
    const paragraphs = here ? neo.chapter(here.chId)?.paragraphs : undefined;
    if (!here || !known || known.lines.length === 0 || !paragraphs) { blameLine.textContent = ''; return; }
    const line = alignBlame(known.lines, paragraphs)[here.pIdx];
    if (!line || line.who === 'uncommitted') blameLine.textContent = 'This paragraph is not in the history yet.';
    else blameLine.textContent = `This paragraph: ${line.who === 'librarian' ? 'the librarian' : line.author}, ${when(line.time * 1000)}`;
  }

  const fetchBlame = async (chId: string) => {
    if (!bookId) return;
    const forBook = bookId;
    try {
      const lines = await neo.invoke('git.blame', { bookId, chId }) as BlameLine[];
      if (bookId !== forBook) return;
      blame.set(chId, { at: Date.now(), lines });
      renderBlame();
    } catch (err) {
      console.debug('hoard: blame', err);
    }
  };

  // Asked for on a chapter switch, and a little after the caret settles in another
  // paragraph, at most every BLAME_EVERY_MS; never on a keystroke.
  const maybeBlame = (chId: string, switched: boolean) => {
    clearTimeout(blameTimer);
    const known = blame.get(chId);
    if (switched || !known) { fetchBlame(chId); return; }
    blameTimer = setTimeout(() => {
      if (Date.now() - (blame.get(chId)?.at ?? 0) >= BLAME_EVERY_MS) fetchBlame(chId);
    }, 2_000);
    renderBlame();
  };

  // ---- actions -------------------------------------------------------------------
  const settle = (chId: string, answer: { marks: Mark[] }) => {
    marks[chId] = answer.marks;
    unreadable.delete(chId);
    redraw(chId);
    paint();
    render();
  };

  const failed = (err: unknown) => say(`Not saved: ${err instanceof Error ? err.message : String(err)}`);

  function goTo(id: string) {
    const span = here ? drawn.get(here.chId)?.found.get(id) : null;
    if (!span || !here) return;
    active = id;
    neo.go({ chId: here.chId, ...span });
  }

  async function sendReply(id: string, box: HTMLTextAreaElement) {
    const body = box.value.trim();
    if (!body || !bookId || !here || pending.has(id)) return;
    const chId = here.chId;
    pending.add(id);
    try {
      settle(chId, await neo.invoke('marks.reply', { bookId, chId, markId: id, body }) as { marks: Mark[] });
      box.value = '';
      say('');
    } catch (err) {
      failed(err);
    } finally {
      pending.delete(id);
    }
  }

  async function changeState(id: string, state: MarkState) {
    if (!bookId || !here) return;
    const chId = here.chId;
    try {
      settle(chId, await neo.invoke('marks.state', { bookId, chId, markId: id, state }) as { marks: Mark[] });
      say('');
    } catch (err) {
      failed(err);
    }
  }

  const stopComposing = (back: boolean) => {
    const at = composing?.place;
    composing = null;
    composer.hidden = true;
    composerText.value = '';
    if (back && at) neo.go(at);
  };

  function addComment() {
    if (!bookId || !here) {
      pane.show();
      say('Put the caret in a chapter, or select some words, then Add Comment.');
      return;
    }
    const paragraphs = neo.chapter(here.chId)?.paragraphs;
    const text = paragraphs?.[here.pIdx];
    if (!paragraphs || !text) {
      pane.show();
      say('There are no words here to comment on.');
      return;
    }
    const { commit: _commit, ...anchor } = anchorAt(paragraphs, here);
    composing = { place: { ...here }, anchor };
    composerQuote.textContent = `“${clip(anchor.exact)}”`;
    composer.hidden = false;
    say('');
    pane.show();
    composerText.focus();
  }

  async function submitComment() {
    const body = composerText.value.trim();
    if (!composing || !bookId || !body) return;
    const { place, anchor } = composing;
    try {
      const answer = await neo.invoke('marks.add', { bookId, chId: place.chId, kind: 'comment', anchor, body }) as { id: string; marks: Mark[] };
      active = answer.id;
      stopComposing(true);
      settle(place.chId, answer);
      say('');
    } catch (err) {
      failed(err);
    }
  }

  addButton.addEventListener('click', addComment);
  composeAdd.addEventListener('click', () => { submitComment(); });
  composeCancel.addEventListener('click', () => stopComposing(true));
  composerText.addEventListener('keydown', (e) => {
    if (submitKey(e)) { e.preventDefault(); submitComment(); }
    if (e.key === 'Escape') { e.preventDefault(); stopComposing(true); }
  });
  neo.addCommand('add-comment', addComment);

  // ---- events --------------------------------------------------------------------
  const reset = () => {
    bookId = null;
    marks = {};
    unreadable = new Set();
    drawn.clear();
    blame.clear();
    here = null;
    active = null;
    stopComposing(false);
    clearTimeout(redrawTimer);
    clearTimeout(blameTimer);
    say('');
  };

  neo.on('book-open', async ({ bookId: opened }) => {
    reset();
    bookId = opened;
    try {
      const listed = await neo.invoke('marks.list', { bookId: opened }) as Listed;
      if (bookId !== opened) return;
      marks = listed.chapters;
      unreadable = new Set(listed.unreadable);
      if (listed.unreadable.length) console.warn('hoard: unreadable marks files', listed.unreadable);
    } catch (err) {
      failed(err);
    }
    redrawAll();
  });
  neo.on('book-close', () => { reset(); render(); });
  neo.on('rendered', () => redrawAll());
  neo.on('chapter-change', ({ chId }) => {
    if (!marks[chId]) return;
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => {
      redraw(chId);
      paint();
      render();
    }, REDRAW_MS);
  });
  neo.on('selection', ({ place }) => {
    if (!place || !bookId) return;
    const switched = here?.chId !== place.chId;
    const movedParagraph = switched || here?.pIdx !== place.pIdx;
    here = { chId: place.chId, pIdx: place.pIdx, off: place.off, len: place.len };
    const d = drawn.get(place.chId);
    const under = d ? markAt(d, marks[place.chId] ?? [], here) : null;
    const changed = under !== active && (under !== null || switched);
    if (changed) active = under;
    if (changed || switched) { paint(); render(); }
    if (movedParagraph) maybeBlame(place.chId, switched);
  });

  render();

  return {
    addComment,
    show: () => pane.show(),
    /** For tests and the console: what the window holds and draws now. */
    state: () => structuredClone({
      bookId, marks, active, here,
      stale: Object.fromEntries([...drawn].map(([chId, d]) => [chId, d.stale])),
    }),
  };
}
