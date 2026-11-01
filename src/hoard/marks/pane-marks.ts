// Marks in the Wiki pane: the page shown beside the book carries its comments and
// suggestions, drawn on its lines and listed under it, so a page looked up can be talked
// over without leaving the manuscript. From here the writer comments on words selected in
// the page, replies, resolves and reopens, and on the librarian's pages suggests a change,
// which the librarian reviews as it does in the book (review/flow.ts). A change the pane
// makes is worked out on a copy of the page (wiki/edit.ts) and written whole by the main
// half (wiki.edit), only while the page is as the pane read it; the wiki book's own
// window owns the page while it is open, so the pane sends the writer there then. Typing
// in the page itself (wiki/pane-edit.ts) is saved through the same writer, as the
// writer's, and on the librarian's pages opens the suggest composer here.
//
// The lines are the pane's own, so the marks are drawn with CSS highlights of the
// plugin's own (hoard-pane-*), not the host's, which mark the open book only. Nothing
// here moves the focus out of the manuscript: only a click or a key in the pane does.
import type { Mark, MarkState } from '../../generated/hoard-marks-v1.js';
import { claim, submitKey } from '../keys.ts';
import { reviewFlow } from '../review/flow.ts';
import { editPage, paragraphTexts, type Spot } from '../wiki/edit.ts';
import { startPaneEdit } from '../wiki/pane-edit.ts';
import { anchorAt, anchorPoint } from './anchor.ts';
import { isSuggestion } from './model.ts';
import { drawChapter, label, NAMES, orderForList, type Drawn } from './view.ts';

interface PageRead { bookId: string; chId: string; title: string; html: string }
interface Pane {
  root: HTMLDivElement;
  body: HTMLDivElement;
  shown(): { chId: string; title: string } | null;
  reload(): Promise<void>;
  onShown(fn: (page: PageRead | null) => void): void;
  beforeLeave(fn: () => Promise<void>): void;
  wide(on: boolean): void;
}
interface Pages { get(target: string): string | undefined }
interface Listed { chapters: Record<string, Mark[]>; unreadable: string[] }
interface Composing { kind: 'comment' | 'suggestion'; anchor: Omit<Mark['anchor'], 'commit'> }
type Written = { ok: true } | { ok: false; reason: 'missing' | 'stale' } | { ok: false; reason: 'refused'; findings: { message: string }[] };

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
const oneLine = (text: string) => text.replace(/\r\n|\r|\n/g, ' ');

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

export function startPaneMarks(neo: NeoApiV5, pane: Pane, o: { pages: () => Pages }) {
  let page: PageRead | null = null;
  let marks: Mark[] = [];
  let unreadable = false;
  let drawn: Drawn | null = null;
  let composing: Composing | null = null;
  // the librarian's pages of the wiki book, read when a page is shown
  let librarians = new Set<string>();
  // a list read that started before the file last answered is dropped
  let generation = 0;
  const busy = new Set<string>();

  const section = el('div', 'hoard-pane-marks');
  const head = el('div', 'hoard-pane-marks-head');
  const heading = el('h4', 'hoard-pane-marks-title', 'Comments on this page');
  const addButton = button('hoard-pane-add', 'Comment on selection');
  const suggestButton = button('hoard-pane-suggest', 'Suggest change');
  suggestButton.hidden = true;
  head.append(heading, addButton, suggestButton);
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
  const suggester = el('div', 'sticky hoard-pane-composer hoard-pane-suggester');
  const suggesterQuote = el('div', 's-ch');
  const changeLabel = el('label', 'hoard-label', 'Your change (Enter suggests it, Esc cancels)');
  const changeText = el('textarea');
  changeText.id = 'hoard-pane-suggest-text';
  changeText.rows = 2;
  changeLabel.htmlFor = changeText.id;
  const whyLabel = el('label', 'hoard-label', 'Why (optional)');
  const whyText = el('textarea');
  whyText.id = 'hoard-pane-suggest-note';
  whyText.rows = 2;
  whyLabel.htmlFor = whyText.id;
  const suggesterActions = el('div', 's-actions');
  const suggestAdd = button('', 'Suggest');
  const suggestCancel = button('', 'Cancel');
  suggesterActions.append(suggestAdd, el('span', 's-sep', '·'), suggestCancel);
  suggester.append(suggesterQuote, changeLabel, changeText, whyLabel, whyText, suggesterActions);
  suggester.hidden = true;
  const list = el('div', 'hoard-list');
  const empty = el('p', 'stickies-empty hoard-empty', 'No comments on this page. Select some of its words, then choose Comment on selection.');
  section.append(head, alert, status, composer, suggester, list, empty);
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
    reply.addEventListener('keydown', (e) => { if (submitKey(e)) { claim(e); send(); } });
    actions.append(replyButton);
    const stateTo = (state: MarkState, text: string, done: string) => {
      const b = button('', text);
      b.dataset.action = text;
      b.addEventListener('click', () => act(mark.id, (bookId, chId) => neo.invoke('marks.state', { bookId, chId, markId: mark.id, state }), done, 'It was not changed'));
      actions.append(el('span', 's-sep', '·'), b);
    };
    if (!isSuggestion(mark.kind)) stateTo(mark.state === 'resolved' ? 'open' : 'resolved', mark.state === 'resolved' ? 'Reopen' : 'Resolve', 'Done.');
    for (const action of flow.cardActions(mark, page!.chId)) {
      const b = button('', action.label);
      b.dataset.action = action.label;
      b.addEventListener('click', () => once(mark.id, action.run));
      actions.append(el('span', 's-sep', '·'), b);
    }
    for (const b of actions.querySelectorAll('button')) b.disabled = busy.has(mark.id);
    root.append(replyLabel, reply, actions);
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
    const asked = ++generation;
    if (!page) { marks = []; redraw(); return; }
    const forPage = page;
    try {
      const listed = await neo.invoke('marks.list', { bookId: forPage.bookId }) as Listed;
      if (page !== forPage || asked !== generation) return;
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
        generation++;
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

  // Runs a card's action once at a time.
  async function once(id: string, run: () => Promise<void>) {
    if (busy.has(id)) return;
    busy.add(id);
    render();
    try {
      await run();
    } finally {
      busy.delete(id);
      render();
    }
  }

  // ---- changing the page -----------------------------------------------------------
  const REFUSED: Record<string, string> = {
    missing: 'the page is no longer in the wiki',
    stale: 'the page had changed since the pane showed it, so it is shown again as it is now',
    words: 'the words had changed',
  };

  // Why the pane cannot write the shown page now, or null.
  const cannotWrite = (): string | null => {
    if (!page) return 'no page is shown';
    if (neo.book()?.id === page.bookId) return 'the wiki is open as a book; make the change there';
    return null;
  };

  // The page written with one change, as whose it is; resolves with why not, or null.
  async function write(chId: string, at: Spot, expected: string, text: string, as: 'librarian' | 'author'): Promise<string | null> {
    const why = cannotWrite();
    if (why) return why;
    const shown = page!;
    if (shown.chId !== chId) return 'another page is shown';
    const after = editPage(shown.html, at, expected, text);
    if (after === null) return REFUSED.words;
    const written = await neo.invoke('wiki.edit', { chId, before: shown.html, after, as }) as Written;
    if (written.ok || written.reason === 'stale') await pane.reload();
    if (written.ok) return null;
    if (written.reason === 'refused') return `the library check refused it: ${written.findings.map((f) => f.message).join(' ')}`;
    return REFUSED[written.reason] ?? written.reason;
  }

  // The writer's typing saved, one paragraph's change at a time, without drawing the page
  // again under the caret: the page's HTML as the pane knows it takes the change. When
  // another device changed the page meanwhile, the change is made again on the page as it
  // is now, if that paragraph still reads as it did, and the page is shown again once the
  // round of saves is done (settle).
  let readAgain = false;
  async function saveTyped(chId: string, at: Spot, expected: string, text: string, was: string): Promise<string | null> {
    const why = cannotWrite();
    if (why) return why;
    const shown = page!;
    if (shown.chId !== chId) return 'another page is shown';
    let before = shown.html;
    let after = editPage(before, at, expected, text);
    if (after === null) return REFUSED.words;
    let written = await neo.invoke('wiki.edit', { chId, before, after, as: 'author' }) as Written;
    if (!written.ok && written.reason === 'stale') {
      readAgain = true;
      const fresh = await neo.invoke('wiki.page', { chId }) as PageRead | null;
      if (!fresh) return REFUSED.missing;
      before = fresh.html;
      after = paragraphTexts(before)[at.pIdx] === was ? editPage(before, at, expected, text) : null;
      if (after === null) return 'the paragraph changed on another device meanwhile';
      written = await neo.invoke('wiki.edit', { chId, before, after, as: 'author' }) as Written;
    }
    if (!written.ok) return written.reason === 'refused' ? `the library check refused it: ${written.findings.map((f) => f.message).join(' ')}` : REFUSED[written.reason] ?? written.reason;
    if (page === shown) shown.html = after;
    return null;
  }

  const flow = reviewFlow(neo, o.pages, {
    bookId: () => page?.bookId ?? null,
    paragraphs: (chId) => (page?.chId === chId ? paragraphs() : null),
    marksOf: (chId) => (page?.chId === chId ? marks : []),
    isLibrarians: (chId) => librarians.has(chId),
    applyAsLibrarian: (chId, at, expected, text) => write(chId, at, expected, text, 'librarian'),
    applyAsWriter: (chId, at, expected, text) => write(chId, at, expected, text, 'author'),
    settle: (chId, answer) => {
      if (page?.chId !== chId) return;
      generation++;
      marks = answer.marks;
      redraw();
    },
    tell: (text) => { status.textContent = text; },
    warn: (text) => { alert.textContent = text; },
    relist: () => { load(); },
  });

  // ---- commenting on and suggesting for a selection ---------------------------------
  const stopComposing = () => {
    composing = null;
    composer.hidden = true;
    composerText.value = '';
    suggester.hidden = true;
    changeText.value = '';
    whyText.value = '';
  };

  // The selection in the page, as one paragraph's span, or why there is none.
  function selected(): { pIdx: number; off: number; len: number } | string {
    const sel = getSelection();
    const all = lines();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const start = range ? pointIn(all, range.startContainer, range.startOffset) : null;
    const end = range ? pointIn(all, range.endContainer, range.endOffset) : null;
    if (!start || !end) return 'Select some words in the page above first.';
    if (start.pIdx !== end.pIdx) return 'Select words within one paragraph of the page.';
    return { pIdx: start.pIdx, off: start.off, len: end.off - start.off };
  }

  function suggestChange(typed?: string) {
    if (!page) return;
    if (composing) { (composing.kind === 'comment' ? composerText : changeText).focus(); return; }
    if (!librarians.has(page.chId)) {
      alert.textContent = 'This page is yours, so there is nobody to review a suggestion.';
      return;
    }
    const why = cannotWrite();
    if (why) { alert.textContent = `A change cannot be suggested here: ${why}.`; return; }
    const span = selected();
    if (typeof span === 'string') { alert.textContent = `${span} Then choose Suggest change.`; return; }
    const { commit: _c, ...anchor } = span.len > 0 ? anchorAt(paragraphs(), span) : anchorPoint(paragraphs(), span);
    composing = { kind: 'suggestion', anchor };
    suggesterQuote.textContent = anchor.exact
      ? `Change “${clip(anchor.exact)}”`
      : `Add words at “…${clip(anchor.prefix.split('\n').pop() ?? '', 40)}”`;
    changeText.value = typed ?? anchor.exact;
    suggester.hidden = false;
    alert.textContent = '';
    changeText.focus();
    changeText.setSelectionRange(changeText.value.length, changeText.value.length);
  }

  async function submitSuggestion() {
    if (!composing || composing.kind !== 'suggestion' || !page || suggestAdd.disabled) return;
    const forPage = page;
    const { anchor } = composing;
    const proposed = oneLine(changeText.value);
    const body = whyText.value.trim() || undefined;
    const kind = anchor.exact === '' ? 'insertion' : proposed === '' ? 'deletion' : 'substitution';
    if (kind === 'insertion' && proposed === '') { status.textContent = 'Type the words to add, or Esc to cancel.'; return; }
    if (proposed === anchor.exact) { status.textContent = 'That is what the page already says. Change it, or Esc to cancel.'; return; }
    suggestAdd.disabled = true;
    try {
      const request: Record<string, unknown> = { bookId: forPage.bookId, chId: forPage.chId, kind, anchor };
      if (kind !== 'deletion') request.proposed = proposed;
      if (body) request.body = body;
      const answer = await neo.invoke('marks.add', request) as { id: string; marks: Mark[] };
      stopComposing();
      if (page !== forPage) return;
      generation++;
      marks = answer.marks;
      redraw();
      await flow.review(forPage.chId, answer.id);
    } catch (err) {
      alert.textContent = `Your suggestion was not saved: ${message(err)}. It is still in the box; suggest it again.`;
    } finally {
      suggestAdd.disabled = false;
    }
  }

  function commentOnSelection() {
    if (!page) return;
    if (composing) { (composing.kind === 'comment' ? composerText : changeText).focus(); return; }
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
    composing = { kind: 'comment', anchor };
    composerQuote.textContent = `On “${clip(anchor.exact)}”`;
    composer.hidden = false;
    alert.textContent = '';
    composerText.focus();
  }

  async function submit() {
    const body = composerText.value.trim();
    if (!composing || composing.kind !== 'comment' || !page || !body) return;
    const forPage = page;
    composeAdd.disabled = true;
    try {
      const answer = await neo.invoke('marks.add', { bookId: forPage.bookId, chId: forPage.chId, kind: 'comment', anchor: composing.anchor, body }) as { marks: Mark[] };
      stopComposing();
      if (page === forPage) { generation++; marks = answer.marks; }
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
  composerText.addEventListener('keydown', (e) => { if (submitKey(e)) { claim(e); submit(); } });
  suggestButton.addEventListener('mousedown', (e) => e.preventDefault());
  suggestButton.addEventListener('click', () => suggestChange());
  suggestAdd.addEventListener('click', () => { submitSuggestion(); });
  suggestCancel.addEventListener('click', stopComposing);
  for (const box of [changeText, whyText]) {
    box.addEventListener('keydown', (e) => {
      // Enter sends from the words, Ctrl+Enter from the note
      if (e.key === 'Enter' && (box === changeText ? !e.shiftKey : submitKey(e))) { claim(e); submitSuggestion(); }
    });
  }
  // NEO takes an Esc from a side pane before the box sees it (capture on the document)
  // and puts the writer back on the page; seen first, from the window, it also stops
  // composing, and NEO still goes back to the page
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && composing && e.target instanceof Node && (composer.contains(e.target) || suggester.contains(e.target))) stopComposing();
  }, true);

  // Which of the wiki's pages are the librarian's, read again with each page shown, since
  // an import adds pages; a failure leaves the page the writer's, which nothing changes.
  async function owners(forPage: PageRead) {
    try {
      const answer = await neo.invoke('review.owners', { bookId: forPage.bookId }) as { librarian: string[] };
      if (page !== forPage) return;
      librarians = new Set(answer.librarian);
    } catch (err) {
      librarians = new Set();
      alert.textContent = `Which pages are the librarian's could not be read: ${message(err)}.`;
    }
    suggestButton.hidden = !librarians.has(forPage.chId);
    editing.refresh();
    render();
  }

  const editing = startPaneEdit(neo, pane, {
    page: () => page,
    cannotWrite,
    isLibrarians: (chId) => librarians.has(chId),
    suggest: (typed) => suggestChange(typed),
    save: saveTyped,
    settle: async () => {
      if (readAgain) {
        readAgain = false;
        await pane.reload();
      } else {
        redraw();
      }
    },
    reload: () => pane.reload(),
    tell: (text) => { status.textContent = text; },
    warn: (text) => { alert.textContent = text; },
  });

  pane.onShown((shown) => {
    const samePage = !!shown && page?.chId === shown.chId;
    page = shown;
    readAgain = false;
    editing.shown();
    stopComposing();
    // a page shown again after a change keeps what the writer was just told
    if (!samePage) {
      alert.textContent = '';
      status.textContent = '';
    }
    suggestButton.hidden = true;
    if (shown) owners(shown);
    load();
  });
  neo.on('book-close', () => {
    // the page may be the wiki book's, whose marks the closing book can change
    if (page) load();
  });

  return {
    commentOnSelection,
    suggestChange,
    /** The page's HTML with one change made, as the pane makes it (wiki/edit.ts). */
    editPage,
    /** What was typed in the page, saved now. */
    flush: () => editing.flush(),
    reload: load,
    /** For tests and the console. */
    state: () => structuredClone({ page: page && { bookId: page.bookId, chId: page.chId }, marks, stale: drawn?.stale ?? [], editing: editing.state() }),
  };
}
