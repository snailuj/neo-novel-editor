// Suggest mode in the window. The librarian's pages (review.owners, from their page
// sidecars) are held: the writer reads and selects there, and their edits become
// suggestions instead of changes. Suggest Change, or a letter, a paste or a delete typed
// on such a page, opens a composer in the Comments section with the selected words, the
// keystroke already applied, so it is not lost. Once added, the librarian reviews the
// suggestion (flow.ts, shared with the Wiki pane), and an accepted change is made here
// as a librarian edit (git/librarian.ts: the writer's commit, the change, the librarian's
// commit). Edit Directly lets the caret's page go until the book closes; the next open is
// in suggest mode again, as the spec has it.
//
// Nothing here runs on a caret move but a redraw of the mode line, and nothing opens
// unless the writer asked: a command, a button, or a keystroke on a page they cannot
// type in.
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { anchorAt, anchorPoint } from '../marks/anchor.ts';
import type { startLibrarian } from '../git/librarian.ts';
import { claim, submitKey } from '../keys.ts';
import type { CardAction, startMarks } from '../marks/window.ts';
import { reviewFlow } from './flow.ts';

type Marks = ReturnType<typeof startMarks>;
type Librarian = ReturnType<typeof startLibrarian>;
interface Pages { get(target: string): string | undefined }
interface Composing {
  chId: string;
  place: NeoPlace;
  anchor: Omit<Mark['anchor'], 'commit'>;
}

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

const clip = (text: string, n = 140) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const oneLine = (text: string) => text.replace(/\r\n|\r|\n/g, ' ');

const REFUSED: Record<string, string> = {
  busy: 'a word was being composed',
  hidden: 'the manuscript was not showing',
  missing: 'the words were not on the page',
  stale: 'the words had changed',
  unsaved: 'your last words on the page had not been saved yet',
  blocked: 'the editor would not make the change',
};

// The held chapter the selection lies in, if this plugin holds it.
function heldChapterOfSelection(held: ReadonlySet<string>): string | null {
  const node = getSelection()?.anchorNode ?? null;
  const elem = node instanceof Element ? node : node?.parentElement;
  const chapter = elem?.closest<HTMLElement>('.chapter[data-held]');
  const chId = chapter?.dataset.id;
  return chId && held.has(chId) ? chId : null;
}

export function startReview(neo: NeoApiV4, marks: Marks, o: { pages: () => Pages; librarian: Librarian }) {
  let bookId: string | null = null;
  let librarian = new Set<string>();
  const direct = new Set<string>();
  let composing: Composing | null = null;
  let submitting = false;

  const held = () => new Set([...librarian].filter((chId) => !direct.has(chId)));
  // hoard's holds are gathered (holds.ts), so a librarian edit's own hold is kept
  let release: () => void = () => {};
  const applyHold = () => {
    const was = release;
    release = o.librarian.holds.hold([...held()]);
    was();
  };
  const isLibrarians = (chId: string) => librarian.has(chId);

  // ---- the mode line and the composer -----------------------------------------------
  const mode = el('div', 'hoard-mode');
  const modeText = el('p', 'hoard-mode-text');
  const suggestButton = button('hoard-suggest', 'Suggest change');
  const directButton = button('hoard-direct', '');
  mode.append(modeText, suggestButton, directButton);
  mode.hidden = true;
  marks.mount(mode);

  const composer = el('div', 'sticky hoard-suggest-composer');
  const composerQuote = el('div', 's-ch');
  const textLabel = el('label', 'hoard-label', 'Your change (Enter suggests it, Esc cancels)');
  const text = el('textarea');
  text.id = 'hoard-suggest-text';
  text.rows = 2;
  textLabel.htmlFor = text.id;
  const noteLabel = el('label', 'hoard-label', 'Why (optional)');
  const note = el('textarea');
  note.id = 'hoard-suggest-note';
  note.rows = 2;
  noteLabel.htmlFor = note.id;
  const composerActions = el('div', 's-actions');
  const composeAdd = button('', 'Suggest');
  const composeCancel = button('', 'Cancel');
  composerActions.append(composeAdd, el('span', 's-sep', '·'), composeCancel);
  composer.append(composerQuote, textLabel, text, noteLabel, note, composerActions);
  composer.hidden = true;
  marks.mount(composer);

  const renderMode = () => {
    const at = marks.where();
    const mine = at && isLibrarians(at.chId);
    mode.hidden = !mine;
    if (!at || !mine) return;
    const suggesting = !direct.has(at.chId);
    modeText.textContent = suggesting
      ? 'The librarian\'s page: your edits are suggestions, which the librarian reviews.'
      : 'The librarian\'s page, edited directly: your edits are yours, and the history says so.';
    directButton.textContent = suggesting ? 'Edit directly' : 'Suggest instead';
  };

  const stopComposing = (back: boolean) => {
    const at = composing?.place;
    composing = null;
    composer.hidden = true;
    text.value = '';
    note.value = '';
    if (back && at) neo.go(at);
  };

  // Opens the composer on the selection, with `typed` standing in for the selected words
  // when the writer started with a keystroke.
  function suggestChange(typed?: string) {
    if (composing) {
      marks.show();
      text.focus();
      marks.tell('Finish or cancel the open suggestion first.');
      return;
    }
    const place = neo.where();
    if (!bookId || !place) {
      marks.show();
      marks.warn('There is nothing to suggest a change to yet. Select some words on one of the librarian\'s pages, then choose Suggest Change.');
      return;
    }
    if (!isLibrarians(place.chId)) {
      marks.show();
      marks.warn('This page is yours, so there is nobody to review a suggestion: type the change.');
      return;
    }
    if (marks.unreadable(place.chId)) { marks.show(); return; }
    const selection = getSelection();
    if (place.len === 0 && selection && !selection.isCollapsed) {
      marks.show();
      marks.warn('A suggestion lies inside one paragraph. Select words within one paragraph, or suggest each paragraph\'s change on its own.');
      return;
    }
    const paragraphs = neo.chapter(place.chId)?.paragraphs;
    if (!paragraphs || paragraphs[place.pIdx] === undefined) return;
    const { commit: _c, ...anchor } = place.len > 0
      ? anchorAt(paragraphs, place)
      : anchorPoint(paragraphs, { pIdx: place.pIdx, off: place.off });
    composing = { chId: place.chId, place: { chId: place.chId, pIdx: place.pIdx, off: place.off, len: place.len }, anchor };
    composerQuote.textContent = anchor.exact
      ? `Change “${clip(anchor.exact)}”`
      : `Add words at “…${clip(anchor.prefix.split('\n').pop() ?? '', 40)}”`;
    text.value = typed ?? anchor.exact;
    composer.hidden = false;
    marks.warn('');
    marks.show();
    text.focus();
    text.setSelectionRange(text.value.length, text.value.length);
  }

  async function submit() {
    if (!composing || !bookId || submitting) return;
    const { chId, anchor } = composing;
    const proposed = oneLine(text.value);
    const body = note.value.trim() || undefined;
    const kind = anchor.exact === '' ? 'insertion' : proposed === '' ? 'deletion' : 'substitution';
    if (kind === 'insertion' && proposed === '') { marks.tell('Type the words to add, or Esc to cancel.'); return; }
    if (proposed === anchor.exact) { marks.tell('That is what the page already says. Change it, or Esc to cancel.'); return; }
    submitting = true;
    composeAdd.disabled = true;
    const forBook = bookId;
    try {
      const request: Record<string, unknown> = { bookId, chId, kind, anchor };
      if (kind !== 'deletion') request.proposed = proposed;
      if (body) request.body = body;
      const answer = await neo.invoke('marks.add', request) as { id: string; marks: Mark[] };
      stopComposing(true);
      marks.settle(chId, answer);
      marks.activate(answer.id);
      if (bookId === forBook && isLibrarians(chId)) await review(chId, answer.id);
    } catch (err) {
      marks.warn(`Your suggestion was not saved: ${message(err)}. It is still in the box; suggest it again.`);
    } finally {
      submitting = false;
      composeAdd.disabled = false;
    }
  }

  // ---- applying a change -----------------------------------------------------------
  // The librarian's change, between the writer's commit and its own. Resolves with why
  // it was not made, or null.
  async function applyAsLibrarian(chId: string, at: { pIdx: number; off: number; len: number }, expected: string, words: string): Promise<string | null> {
    const place = { chId, ...at };
    const edit = await o.librarian.replace(place, expected, words);
    if (edit.ok) return edit.result.ok ? null : REFUSED[edit.result.reason] ?? edit.result.reason;
    if (edit.reason !== 'refused') return REFUSED[edit.reason] ?? edit.reason;
    // The library check refused the librarian's commit, so the change is on the page but
    // in no commit: put the words back, and the words proposed stay in the suggestion.
    const back = await neo.replace({ ...place, len: words.length }, words, expected);
    const found = edit.findings.map((f) => f.message).join(' ');
    if (!back.ok) {
      console.warn('hoard: a refused change could not be put back', back.reason);
      return `the library check refused it (${found}), and the page still holds the change, which your next save commits as yours`;
    }
    return `the library check refused it: ${found}`;
  }

  // The writer's own change, as typing makes it; the next checkpoint commits it as theirs.
  async function applyAsWriter(chId: string, at: { pIdx: number; off: number; len: number }, expected: string, words: string): Promise<string | null> {
    const result = await neo.replace({ chId, ...at }, expected, words);
    return result.ok ? null : REFUSED[result.reason] ?? result.reason;
  }

  const flow = reviewFlow(neo, o.pages, {
    bookId: () => bookId,
    paragraphs: (chId) => neo.chapter(chId)?.paragraphs ?? null,
    marksOf: (chId) => marks.marksOf(chId),
    isLibrarians,
    applyAsLibrarian,
    applyAsWriter,
    settle: (chId, answer) => marks.settle(chId, answer),
    tell: (text) => marks.tell(text),
    warn: (text) => marks.warn(text),
    relist: () => marks.relist(),
  });
  const { review } = flow;

  marks.extend({
    cardActions: (mark: Mark, chId: string): CardAction[] => flow.cardActions(mark, chId),
    rendered: renderMode,
  });

  const toggleDirect = () => {
    const at = marks.where();
    if (!at || !isLibrarians(at.chId)) {
      marks.show();
      marks.warn('Put the caret in one of the librarian\'s pages to switch between suggesting and editing it directly.');
      return;
    }
    if (direct.has(at.chId)) direct.delete(at.chId);
    else direct.add(at.chId);
    applyHold();
    renderMode();
    marks.tell(direct.has(at.chId) ? 'Editing this page directly until the book closes.' : 'Suggesting on this page again.');
  };

  // ---- wiring ---------------------------------------------------------------------
  suggestButton.addEventListener('click', () => suggestChange());
  directButton.addEventListener('click', toggleDirect);
  composeAdd.addEventListener('click', () => { submit(); });
  composeCancel.addEventListener('click', () => stopComposing(true));
  for (const box of [text, note]) {
    box.addEventListener('keydown', (e) => {
      // Enter sends from the words, Ctrl+Enter from the note
      if (e.key === 'Enter' && (box === text ? !e.shiftKey : submitKey(e))) { claim(e); submit(); }
    });
  }
  // NEO takes an Esc from a side pane before the boxes see it (capture on the document)
  // and puts the writer back on the page; seen first, from the window, it also drops
  // the suggestion, and NEO still goes back to the page
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && composing && e.target instanceof Node && composer.contains(e.target)) stopComposing(false);
  }, true);
  neo.addCommand('suggest-change', () => suggestChange());
  neo.addCommand('edit-directly', toggleDirect);

  // A keystroke on a page the writer cannot type in starts a suggestion with it.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || composing) return;
    const chId = heldChapterOfSelection(held());
    if (!chId) return;
    const sel = getSelection();
    if (e.key.length === 1) {
      e.preventDefault();
      suggestChange(e.key);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && sel && !sel.isCollapsed) {
      e.preventDefault();
      suggestChange('');
    }
  }, true);
  document.addEventListener('paste', (e) => {
    if (composing || !heldChapterOfSelection(held())) return;
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    if (!pasted) return;
    e.preventDefault();
    suggestChange(oneLine(pasted));
  }, true);

  neo.on('book-open', async ({ bookId: opened }) => {
    bookId = opened;
    librarian = new Set();
    direct.clear();
    try {
      const answer = await neo.invoke('review.owners', { bookId: opened }) as { librarian: string[] };
      if (bookId !== opened) return;
      librarian = new Set(answer.librarian);
    } catch (err) {
      marks.warn(`Which pages are the librarian's could not be read: ${message(err)}. They open for direct editing; open the book again to retry.`);
    }
    applyHold();
    renderMode();
  });
  neo.on('book-close', () => {
    bookId = null;
    librarian = new Set();
    direct.clear();
    release();
    release = () => {};
    stopComposing(false);
    renderMode();
  });

  return {
    suggestChange,
    review,
    /** For tests and the console. */
    state: () => structuredClone({ bookId, librarian: [...librarian], direct: [...direct], held: [...held()], composing }),
  };
}
