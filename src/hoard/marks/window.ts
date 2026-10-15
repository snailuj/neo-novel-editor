// The writer's marks in the window: highlights on the page and a Comments section in the
// right-hand pane beside the manuscript. The section lists the marks of the chapter the
// caret is in, each with its thread, a reply box and Resolve or Reopen, and names who
// last wrote the caret's paragraph, from git blame.
//
// Nothing here interrupts typing. A caret move never opens the section or moves the
// focus; it only marks the mark under the caret as the active one. The section opens
// when the writer asks (Add Comment, from the Plugins menu or its own button), and a
// redraw never rebuilds a box the writer is typing in. Every write goes through the main
// half, which answers with the chapter's marks as the file now holds them. Each action
// runs once at a time: its button is disabled and its handler refuses while it is out.
// The state machine this follows is in the plan (Marks-Live-In-Sidecars, "Comments
// section states").
import type { Mark, MarkState } from '../../generated/hoard-marks-v1.js';
import { alignBlame } from '../git/align.ts';
import type { BlameLine } from '../git/blame.ts';
import { anchorAt } from './anchor.ts';
import { drawChapter, label, markAt, NAMES, orderForList, type Drawn, type Place } from './view.ts';

interface Listed { chapters: Record<string, Mark[]>; unreadable: string[] }
interface Composing { place: Place; anchor: Omit<Mark['anchor'], 'commit'> }
interface Item {
  root: HTMLDivElement;
  quote: HTMLButtonElement;
  thread: HTMLDivElement;
  shown: string;
  reply: HTMLTextAreaElement;
  replyButton: HTMLButtonElement;
  stateButton: HTMLButtonElement;
  extra: HTMLSpanElement;
  extraShown: string;
}

/** A button another part of the plugin puts on a card (review/window.ts: Accept Anyway, Withdraw). */
export interface CardAction {
  label: string;
  run: () => Promise<void>;
}

/** What another part of the plugin adds to the Comments section. */
export interface MarksExtension {
  /** The buttons a card shows beside Reply, for a mark of the chapter chId. */
  cardActions?(mark: Mark, chId: string): CardAction[];
  /** Told after the section has drawn, for a part that keeps its own line in it. */
  rendered?(): void;
}

const REDRAW_MS = 300;
const BLAME_EVERY_MS = 15_000;
const STATUS_MS = 4_000;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const button = (className: string, text: string) => {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
};

const when = (at: string | number) => new Date(at).toLocaleString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const who = (w: string) => (w === 'librarian' ? 'Librarian' : 'You');
const clip = (text: string, n = 140) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const submitKey = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function startMarks(neo: NeoApiV3) {
  const pane = neo.addPane({ id: 'comments', title: 'Comments', side: true });
  let bookId: string | null = null;
  let marks: Record<string, Mark[]> = {};
  let unreadable = new Set<string>();
  const drawn = new Map<string, Drawn>();
  let here: Place | null = null;
  let active: string | null = null;
  let composing: Composing | null = null;
  let submitting = false;
  const busy = new Set<string>();
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  const blame = new Map<string, { at: number; lines: BlameLine[] }>();
  let blameTimer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- the section's parts, made once --------------------------------------------
  const root = pane.element;
  root.classList.add('hoard-marks');
  const head = el('div', 'hoard-marks-head');
  const blameLine = el('p', 'hoard-blame');
  const addButton = button('hoard-add', 'Add comment');
  head.append(blameLine, addButton);
  const alert = el('p', 'hoard-alert');
  alert.setAttribute('role', 'alert');
  const status = el('p', 'hoard-status');
  status.setAttribute('role', 'status');
  const composer = el('div', 'sticky hoard-composer');
  const composerQuote = el('div', 's-ch');
  const composerLabel = el('label', 'hoard-label', 'Your comment (Ctrl+Enter adds it, Esc cancels)');
  const composerText = el('textarea');
  composerText.id = 'hoard-compose-text';
  composerLabel.htmlFor = composerText.id;
  const composerActions = el('div', 's-actions');
  const composeAdd = button('', 'Add comment');
  const composeCancel = button('', 'Cancel');
  composerActions.append(composeAdd, el('span', 's-sep', '·'), composeCancel);
  composer.append(composerQuote, composerLabel, composerText, composerActions);
  composer.hidden = true;
  const list = el('div', 'hoard-list');
  const empty = el('p', 'stickies-empty hoard-empty', 'No comments in this chapter. Select some words, then choose Add Comment.');
  root.append(head, alert, status, composer, list, empty);
  const items = new Map<string, Item>();
  const extensions: MarksExtension[] = [];

  const warn = (text: string) => { alert.textContent = text; };
  const tell = (text: string) => {
    status.textContent = text;
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { status.textContent = ''; }, STATUS_MS);
  };

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
    const quote = button('s-ch hoard-quote', '');
    quote.addEventListener('click', () => goTo(mark.id));
    const thread = el('div', 'hoard-thread');
    const reply = el('textarea', 'hoard-reply');
    reply.id = `hoard-reply-${mark.id}`;
    const label = el('label', 'hoard-label', 'Reply (Ctrl+Enter sends it)');
    label.htmlFor = reply.id;
    const actions = el('div', 's-actions');
    const replyButton = button('', 'Reply');
    const stateButton = button('', '');
    const extra = el('span', 'hoard-extra');
    actions.append(replyButton, el('span', 's-sep', '·'), stateButton, extra);
    itemRoot.append(quote, thread, label, reply, actions);
    const send = () => sendReply(mark.id, reply);
    replyButton.addEventListener('click', send);
    reply.addEventListener('keydown', (e) => {
      if (submitKey(e)) { e.preventDefault(); send(); }
      if (e.key === 'Escape') { e.preventDefault(); reply.blur(); }
    });
    stateButton.addEventListener('click', () => {
      const now = currentMark(mark.id);
      if (now) changeState(mark.id, now.state === 'resolved' ? 'open' : 'resolved');
    });
    const item: Item = { root: itemRoot, quote, thread, shown: '', reply, replyButton, stateButton, extra, extraShown: '' };
    items.set(mark.id, item);
    return item;
  };

  const fill = (item: Item, mark: Mark, stale: boolean) => {
    const closed = mark.state !== 'open' && mark.state !== 'flagged';
    item.root.classList.toggle('stale', stale);
    item.root.classList.toggle('resolved', closed);
    item.root.classList.toggle('active', mark.id === active);
    if (mark.id === active) item.root.setAttribute('aria-current', 'true');
    else item.root.removeAttribute('aria-current');
    item.quote.textContent = `${stale ? 'Not found: ' : ''}${label(mark)}${closed ? ` · ${mark.state}` : ''}`;
    item.quote.disabled = stale;
    item.quote.title = stale ? 'These words are no longer in the chapter; the comment stays here.' : 'Go to these words';
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
    item.replyButton.disabled = busy.has(mark.id);
    item.stateButton.disabled = busy.has(mark.id);
    fillExtra(item, mark);
  };

  // Buttons rebuilt only when their labels change, so one holding the focus keeps it.
  function fillExtra(item: Item, mark: Mark) {
    const chId = here?.chId;
    const wanted = chId ? extensions.flatMap((x) => x.cardActions?.(mark, chId) ?? []) : [];
    const shown = wanted.map((a) => a.label).join('\n');
    if (shown !== item.extraShown) {
      item.extra.replaceChildren(...wanted.map((action) => {
        const b = button('', action.label);
        b.dataset.action = action.label;
        return b;
      }));
      item.extraShown = shown;
    }
    [...item.extra.children].forEach((node, i) => {
      const b = node as HTMLButtonElement;
      const action = wanted[i];
      b.disabled = busy.has(mark.id);
      b.onclick = () => { runAction(mark.id, action); };
      b.hidden = false;
    });
    item.extra.hidden = wanted.length === 0;
  }

  async function runAction(id: string, action: CardAction) {
    if (busy.has(id)) return;
    busy.add(id);
    render();
    try {
      await action.run();
    } finally {
      busy.delete(id);
      render();
    }
  }

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
    empty.hidden = wanted.length > 0 || !bookId || (chId !== null && unreadable.has(chId));
    if (chId && unreadable.has(chId)) {
      warn('This chapter\'s comments file could not be read, so it is left untouched and no comment can be added here. neo-errors.log names the file; mend or move it, then open the book again.');
    }
    renderBlame();
    for (const x of extensions) x.rendered?.();
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
    if (switched || !blame.has(chId)) { fetchBlame(chId); return; }
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

  // After a refusal the file may hold what another device wrote: read it again.
  const relist = async () => {
    if (!bookId) return;
    const forBook = bookId;
    try {
      const listed = await neo.invoke('marks.list', { bookId }) as Listed;
      if (bookId !== forBook) return;
      marks = listed.chapters;
      unreadable = new Set(listed.unreadable);
      redrawAll();
    } catch (err) {
      console.debug('hoard: marks.list', err);
    }
  };

  function goTo(id: string) {
    const span = here ? drawn.get(here.chId)?.found.get(id) : null;
    if (!span || !here) return;
    active = id;
    neo.go({ chId: here.chId, ...span });
  }

  async function sendReply(id: string, box: HTMLTextAreaElement) {
    const body = box.value.trim();
    if (!body || !bookId || !here || busy.has(id)) return;
    const chId = here.chId;
    busy.add(id);
    render();
    try {
      settle(chId, await neo.invoke('marks.reply', { bookId, chId, markId: id, body }) as { marks: Mark[] });
      box.value = '';
      warn('');
      tell('Reply added.');
    } catch (err) {
      warn(`Your reply was not saved: ${message(err)}. It is still in the box; send it again.`);
      relist();
    } finally {
      busy.delete(id);
      render();
    }
  }

  async function changeState(id: string, state: MarkState) {
    if (!bookId || !here || busy.has(id)) return;
    const chId = here.chId;
    busy.add(id);
    render();
    try {
      settle(chId, await neo.invoke('marks.state', { bookId, chId, markId: id, state }) as { marks: Mark[] });
      warn('');
      tell(state === 'resolved' ? 'Comment resolved. Reopen brings it back.' : 'Comment reopened.');
    } catch (err) {
      warn(`The comment was not changed: ${message(err)}. The list now shows it as the file holds it; try again if it still needs changing.`);
      relist();
    } finally {
      busy.delete(id);
      render();
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
    if (composing) {
      // a second Add Comment keeps the open comment, its words and its passage
      pane.show();
      composerText.focus();
      tell('Finish or cancel the open comment first.');
      return;
    }
    if (!bookId || !here) {
      pane.show();
      warn('There is nothing to comment on yet. Put the caret in a chapter, or select some words, then choose Add Comment.');
      return;
    }
    if (unreadable.has(here.chId)) { pane.show(); render(); return; }
    const paragraphs = neo.chapter(here.chId)?.paragraphs;
    if (!paragraphs?.[here.pIdx]) {
      pane.show();
      warn('This paragraph is empty. Put the caret in a paragraph with words, or select some, then choose Add Comment.');
      return;
    }
    const { commit: _commit, ...anchor } = anchorAt(paragraphs, here);
    composing = { place: { ...here }, anchor };
    composerQuote.textContent = `On “${clip(anchor.exact)}”`;
    composer.hidden = false;
    warn('');
    pane.show();
    composerText.focus();
  }

  async function submitComment() {
    const body = composerText.value.trim();
    if (!composing || !bookId || !body || submitting) return;
    const { place, anchor } = composing;
    submitting = true;
    composeAdd.disabled = true;
    try {
      const answer = await neo.invoke('marks.add', { bookId, chId: place.chId, kind: 'comment', anchor, body }) as { id: string; marks: Mark[] };
      active = answer.id;
      stopComposing(true);
      settle(place.chId, answer);
      warn('');
      tell('Comment added.');
    } catch (err) {
      warn(`Your comment was not saved: ${message(err)}. It is still in the box; add it again.`);
    } finally {
      submitting = false;
      composeAdd.disabled = false;
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
    busy.clear();
    here = null;
    active = null;
    stopComposing(false);
    clearTimeout(redrawTimer);
    clearTimeout(blameTimer);
    warn('');
    tell('');
  };

  neo.on('book-open', async ({ bookId: opened }) => {
    reset();
    bookId = opened;
    try {
      const listed = await neo.invoke('marks.list', { bookId: opened }) as Listed;
      if (bookId !== opened) return;
      marks = listed.chapters;
      unreadable = new Set(listed.unreadable);
    } catch (err) {
      warn(`This book's comments could not be read: ${message(err)}. Open the book again to retry.`);
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
    /** Another part of the plugin's buttons on cards and lines in the section. */
    extend(x: MarksExtension) {
      extensions.push(x);
      render();
    },
    /** The section's head, after the blame line, for a part's own controls. */
    head,
    /** Puts a part's own element in the section, before the list. */
    mount(node: HTMLElement) { root.insertBefore(node, list); },
    warn,
    tell,
    /** The open book and the caret's chapter, as the section knows them. */
    where: () => (bookId && here ? { bookId, ...here } : null),
    marksOf: (chId: string) => marks[chId] ?? [],
    unreadable: (chId: string) => unreadable.has(chId),
    /** Takes the main half's answer for a chapter: the marks as the file now holds them. */
    settle,
    relist: () => relist(),
    activate(id: string | null) { active = id; paint(); render(); },
    /** For tests and the console: what the window holds and draws now. */
    state: () => structuredClone({
      bookId, marks, active, here,
      stale: Object.fromEntries([...drawn].map(([chId, d]) => [chId, d.stale])),
    }),
  };
}
