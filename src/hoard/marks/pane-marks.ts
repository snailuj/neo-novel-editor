// Marks in the Wiki pane: the page shown beside the book carries its comments and
// suggestions, drawn on its lines and listed under it, so a page looked up can be talked
// over without leaving the manuscript. From here the writer comments on words selected in
// the page, replies, resolves and reopens, and withdraws a waiting suggestion. All of
// these write only the page's marks sidecar. Suggesting and accepting change the page
// itself, so they stay in the wiki book until the pane can write a page (the plan's
// sub-step 4).
//
// The lines are the pane's own, so the marks are drawn with CSS highlights of the
// plugin's own (hoard-pane-*), not the host's, which mark the open book only. Nothing
// here moves the focus out of the manuscript: only a click or a key in the pane does.
import type { Mark, MarkState } from '../../generated/hoard-marks-v1.js';
import { anchorAt } from './anchor.ts';
import { isSuggestion } from './model.ts';
import { drawChapter, label, NAMES, orderForList, type Drawn } from './view.ts';

interface PageRead { bookId: string; chId: string; title: string; html: string }
interface Pane {
  root: HTMLDivElement;
  body: HTMLDivElement;
  shown(): { chId: string; title: string } | null;
  onShown(fn: (page: PageRead | null) => void): void;
}
interface Listed { chapters: Record<string, Mark[]>; unreadable: string[] }
interface Composing { anchor: Omit<Mark['anchor'], 'commit'> }

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

const when = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const who = (w: string) => (w === 'librarian' ? 'Librarian' : 'You');
const clip = (text: string, n = 140) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const submitKey = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);
// A Ctrl+Enter a box sends with goes no further: NEO toggles fullscreen on one that
// reaches the document, whether or not something took it first.
const keep = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); };

/** The range of a line's text from off to off + len, counted as textContent counts. */
export function rangeIn(line: Element, off: number, len: number): Range | null {
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let at = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const n = node.textContent?.length ?? 0;
    if (!started && off <= at + n) { range.setStart(node, off - at); started = true; }
    if (started && off + len <= at + n) { range.setEnd(node, off + len - at); return range; }
    at += n;
  }
  return null;
}

// Where a point of the selection falls: its line and offset in that line's text.
function pointIn(lines: Element[], node: Node, offset: number): { pIdx: number; off: number } | null {
  const pIdx = lines.findIndex((line) => line.contains(node));
  if (pIdx === -1) return null;
  const before = document.createRange();
  before.setStart(lines[pIdx], 0);
  before.setEnd(node, offset);
  return { pIdx, off: before.toString().length };
}

export function startPaneMarks(neo: NeoApiV4, pane: Pane) {
  let page: PageRead | null = null;
  let marks: Mark[] = [];
  let unreadable = false;
  let drawn: Drawn | null = null;
  let composing: Composing | null = null;
  const busy = new Set<string>();

  const section = el('div', 'hoard-pane-marks');
  const head = el('div', 'hoard-pane-marks-head');
  const heading = el('h4', 'hoard-pane-marks-title', 'Comments on this page');
  const addButton = button('hoard-pane-add', 'Comment on selection');
  head.append(heading, addButton);
  const alert = el('p', 'hoard-alert');
  alert.setAttribute('role', 'alert');
  const status = el('p', 'hoard-status');
  status.setAttribute('role', 'status');
  const composer = el('div', 'sticky hoard-pane-composer');
  const composerQuote = el('div', 's-ch');
  const composerLabel = el('label', 'hoard-label', 'Comment on these words (Ctrl+Enter adds it, Esc cancels)');
  const composerText = el('textarea');
  composerText.id = 'hoard-pane-compose-text';
  composerLabel.htmlFor = composerText.id;
  const composerActions = el('div', 's-actions');
  const composeAdd = button('', 'Add comment');
  const composeCancel = button('', 'Cancel');
  composerActions.append(composeAdd, el('span', 's-sep', '·'), composeCancel);
  composer.append(composerQuote, composerLabel, composerText, composerActions);
  composer.hidden = true;
  const list = el('div', 'hoard-list');
  const empty = el('p', 'stickies-empty hoard-empty', 'No comments on this page. Select some of its words, then choose Comment on selection.');
  section.append(head, alert, status, composer, list, empty);
  section.hidden = true;
  pane.root.append(section);

  const lines = () => [...pane.body.querySelectorAll<HTMLElement>(':scope > p')];
  const paragraphs = () => lines().map((line) => line.textContent ?? '');

  // ---- drawing ---------------------------------------------------------------------
  const paint = () => {
    const all = lines();
    for (const name of NAMES) {
      const key = `hoard-pane-${name}`;
      const ranges = (drawn?.places[name] ?? []).map((p) => (all[p.pIdx] ? rangeIn(all[p.pIdx], p.off, p.len) : null)).filter((r): r is Range => !!r);
      if (ranges.length) CSS.highlights.set(key, new Highlight(...ranges));
      else CSS.highlights.delete(key);
    }
  };

  const card = (mark: Mark, stale: boolean): HTMLDivElement => {
    const root = el('div', 'sticky hoard-mark');
    root.dataset.mark = mark.id;
    const closed = mark.state !== 'open' && mark.state !== 'flagged';
    root.classList.toggle('stale', stale);
    root.classList.toggle('resolved', closed);
    root.append(el('div', 's-ch hoard-quote', `${stale ? 'Not found: ' : ''}${label(mark)}${closed ? ` · ${mark.state}` : mark.state === 'flagged' ? ' · flagged' : ''}`));
    const thread = el('div', 'hoard-thread');
    for (const entry of mark.thread) {
      const p = el('p', 'hoard-entry');
      p.append(el('span', 'hoard-who', `${who(entry.who)} · ${when(entry.at)}`), el('span', 'hoard-body', entry.body));
      thread.append(p);
    }
    root.append(thread);
    const reply = el('textarea', 'hoard-reply');
    reply.id = `hoard-pane-reply-${mark.id}`;
    const replyLabel = el('label', 'hoard-label', 'Answer (Ctrl+Enter sends it)');
    replyLabel.htmlFor = reply.id;
    const actions = el('div', 's-actions');
    const replyButton = button('', 'Reply');
    const send = () => act(mark.id, async (bookId, chId) => {
      const body = reply.value.trim();
      if (!body) return null;
      return neo.invoke('marks.reply', { bookId, chId, markId: mark.id, body });
    }, 'Reply added.', 'Your reply was not saved');
    replyButton.addEventListener('click', send);
    reply.addEventListener('keydown', (e) => { if (submitKey(e)) { keep(e); send(); } });
    actions.append(replyButton);
    const stateTo = (state: MarkState, text: string, done: string) => {
      const b = button('', text);
      b.dataset.action = text;
      b.addEventListener('click', () => act(mark.id, (bookId, chId) => neo.invoke('marks.state', { bookId, chId, markId: mark.id, state }), done, 'It was not changed'));
      actions.append(el('span', 's-sep', '·'), b);
    };
    if (!isSuggestion(mark.kind)) stateTo(mark.state === 'resolved' ? 'open' : 'resolved', mark.state === 'resolved' ? 'Reopen' : 'Resolve', 'Done.');
    else if (!closed) stateTo('rejected', mark.created.who === 'author' ? 'Withdraw' : 'Reject', 'Suggestion withdrawn; its words stay in its card.');
    for (const b of actions.querySelectorAll('button')) b.disabled = busy.has(mark.id);
    root.append(replyLabel, reply, actions);
    if (isSuggestion(mark.kind) && !closed) root.append(el('p', 'hoard-label', 'Accepting changes the page: open it with Edit in Wiki Book to do that.'));
    return root;
  };

  // A redraw rebuilds the cards, so it waits while the writer is typing in one.
  const render = () => {
    section.hidden = !page;
    if (!page) { list.replaceChildren(); return; }
    if (list.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'TEXTAREA') return;
    const d = drawn;
    const ordered = d ? orderForList(marks, d) : marks;
    list.replaceChildren(...ordered.map((m) => card(m, d ? d.stale.includes(m.id) : false)));
    empty.hidden = ordered.length > 0;
    alert.textContent = unreadable ? 'This page\'s comments file could not be read, so it is left untouched. neo-errors.log names the file.' : alert.textContent;
    addButton.disabled = unreadable;
  };

  const redraw = () => {
    drawn = page ? drawChapter(page.chId, marks, paragraphs()) : null;
    paint();
    render();
  };

  const load = async () => {
    if (!page) { marks = []; redraw(); return; }
    const forPage = page;
    try {
      const listed = await neo.invoke('marks.list', { bookId: forPage.bookId }) as Listed;
      if (page !== forPage) return;
      marks = listed.chapters[forPage.chId] ?? [];
      unreadable = listed.unreadable.includes(forPage.chId);
    } catch (err) {
      alert.textContent = `This page's comments could not be read: ${message(err)}.`;
    }
    redraw();
  };

  // Runs one action on a mark, once at a time, and takes the file's answer.
  async function act(id: string, run: (bookId: string, chId: string) => Promise<unknown>, done: string, failed: string) {
    if (!page || busy.has(id)) return;
    const forPage = page;
    busy.add(id);
    render();
    try {
      const answer = await run(forPage.bookId, forPage.chId) as { marks: Mark[] } | null;
      if (answer && page === forPage) {
        marks = answer.marks;
        alert.textContent = '';
        status.textContent = done;
      }
    } catch (err) {
      alert.textContent = `${failed}: ${message(err)}. The list now shows the page's comments as the file holds them.`;
      await load();
    } finally {
      busy.delete(id);
      (document.activeElement as HTMLElement | null)?.blur?.();
      redraw();
    }
  }

  // ---- commenting on a selection ----------------------------------------------------
  const stopComposing = () => {
    composing = null;
    composer.hidden = true;
    composerText.value = '';
  };

  function commentOnSelection() {
    if (!page) return;
    if (composing) { composerText.focus(); return; }
    const sel = getSelection();
    const all = lines();
    const start = sel && sel.rangeCount ? pointIn(all, sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset) : null;
    const end = sel && sel.rangeCount ? pointIn(all, sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset) : null;
    if (!start || !end || sel?.isCollapsed) {
      alert.textContent = 'Select some words in the page above, then choose Comment on selection.';
      return;
    }
    if (start.pIdx !== end.pIdx) {
      alert.textContent = 'A comment lies inside one paragraph. Select words within one paragraph of the page.';
      return;
    }
    const { commit: _c, ...anchor } = anchorAt(paragraphs(), { pIdx: start.pIdx, off: start.off, len: end.off - start.off });
    composing = { anchor };
    composerQuote.textContent = `On “${clip(anchor.exact)}”`;
    composer.hidden = false;
    alert.textContent = '';
    composerText.focus();
  }

  async function submit() {
    const body = composerText.value.trim();
    if (!composing || !page || !body) return;
    const forPage = page;
    composeAdd.disabled = true;
    try {
      const answer = await neo.invoke('marks.add', { bookId: forPage.bookId, chId: forPage.chId, kind: 'comment', anchor: composing.anchor, body }) as { marks: Mark[] };
      stopComposing();
      if (page === forPage) marks = answer.marks;
      status.textContent = 'Comment added.';
      redraw();
    } catch (err) {
      alert.textContent = `Your comment was not saved: ${message(err)}. It is still in the box; add it again.`;
    } finally {
      composeAdd.disabled = false;
    }
  }

  // keep the page's selection when the button is pressed
  addButton.addEventListener('mousedown', (e) => e.preventDefault());
  addButton.addEventListener('click', commentOnSelection);
  composeAdd.addEventListener('click', () => { submit(); });
  composeCancel.addEventListener('click', stopComposing);
  composerText.addEventListener('keydown', (e) => { if (submitKey(e)) { keep(e); submit(); } });
  // NEO takes an Esc from a side pane before the box sees it (capture on the document)
  // and puts the writer back on the page; seen first, from the window, it also stops
  // composing, and NEO still goes back to the page
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && composing && e.target instanceof Node && composer.contains(e.target)) stopComposing();
  }, true);

  pane.onShown((shown) => {
    page = shown;
    stopComposing();
    alert.textContent = '';
    status.textContent = '';
    load();
  });
  neo.on('book-close', () => {
    // the page may be the wiki book's, whose marks the closing book can change
    if (page) load();
  });

  return {
    commentOnSelection,
    reload: load,
    /** For tests and the console. */
    state: () => structuredClone({ page: page && { bookId: page.bookId, chId: page.chId }, marks, stale: drawn?.stale ?? [] }),
  };
}
