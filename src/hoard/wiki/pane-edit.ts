// Editing in the Wiki pane: the page shown beside the book is edited in place, as NEO's own
// pages are (contenteditable), so the writer can put a fact right in their world-building
// without leaving their place in the manuscript.
//
// On the writer's own pages typing is saved 800 ms after it stops, when the focus leaves
// the page, and before the pane shows another page: each paragraph that changed is one
// change (wiki/change.ts), written by the main half as the writer's (wiki.edit). On the
// librarian's pages a keystroke opens the pane's suggest composer instead, as it does in
// the book, until the writer chooses Edit directly, which lasts for that page until the
// open book closes.
//
// The words change within a paragraph only. Paragraphs carry the block ids citations point
// at ([[Page#^id]]), so making, joining and splitting them, pasting several lines and
// formatting are left to the wiki book, and the pane says so. Nothing is written while the
// wiki is the open book, whose window owns its files. While the writer edits, the pane asks
// the host for more room (host API 5's wide).
import { textChange } from './change.ts';
import type { Spot } from './edit.ts';

interface Pane {
  root: HTMLDivElement;
  body: HTMLDivElement;
  beforeLeave(fn: () => Promise<void>): void;
  wide(on: boolean): void;
}

export interface PaneEditOptions {
  /** The page shown, or null. */
  page(): { bookId: string; chId: string } | null;
  /** Why the page shown cannot be written now, or null. */
  cannotWrite(): string | null;
  isLibrarians(chId: string): boolean;
  /** The suggest composer opened on the selection, with typed for the selected words. */
  suggest(typed: string): void;
  /**
   * One change written as the writer's, to a paragraph that read was; resolves with why
   * not, or null once it is.
   */
  save(chId: string, at: Spot, expected: string, text: string, was: string): Promise<string | null>;
  /** After a round of saves: the marks drawn again, or the page read again where it must be. */
  settle(): Promise<void>;
  /** The page shown again as saved. */
  reload(): Promise<void>;
  tell(text: string): void;
  warn(text: string): void;
}

const SAVE_AFTER = 800;
const STRUCTURE = 'In the pane, words change within a paragraph. New paragraphs, joining two, pasting several lines and formatting are done in the wiki book: choose Edit in Wiki Book.';
const LIBRARIANS = 'This is the librarian\'s page: select words and type to suggest a change, or choose Edit directly.';
// what the pane leaves to the wiki book
const REFUSED = /^(?:insertParagraph|insertLineBreak|insertOrderedList|insertUnorderedList|insertHorizontalRule|insertLink|insertFromDrop|deleteByDrag|format)/;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const clip = (text: string, n = 300) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function startPaneEdit(neo: Pick<NeoApiV5, 'on'>, pane: Pane, o: PaneEditOptions) {
  const { body } = pane;
  // the librarian's pages the writer chose to edit directly, until the open book closes
  const direct = new Set<string>();
  // each line's words as last saved, or as shown
  let saved: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();
  // a page shown again from inside a round of saves must not wait for that round
  let settling = false;

  const mode = el('div', 'hoard-pane-mode');
  const modeText = el('p', 'hoard-pane-mode-text');
  const directButton = el('button', 'hoard-pane-direct');
  directButton.type = 'button';
  mode.append(modeText, directButton);
  mode.hidden = true;
  body.before(mode);

  const lines = () => [...body.querySelectorAll<HTMLElement>(':scope > p')];
  const texts = () => lines().map((line) => line.textContent ?? '');
  const editable = () => !!o.page() && !o.cannotWrite();
  const suggesting = () => {
    const page = o.page();
    return !!page && o.isLibrarians(page.chId) && !direct.has(page.chId);
  };

  /** The page made editable or not, and the librarian's mode line, as things stand. */
  function refresh() {
    const page = o.page();
    const on = editable();
    body.contentEditable = on ? 'true' : 'false';
    if (!on && body.contains(document.activeElement)) pane.wide(false);
    mode.hidden = !on || !page || !o.isLibrarians(page.chId);
    if (mode.hidden || !page) return;
    const isDirect = direct.has(page.chId);
    modeText.textContent = isDirect
      ? 'The librarian\'s page, edited directly: your edits are yours, and the history says so.'
      : 'The librarian\'s page: what you type here is suggested, and the librarian reviews it.';
    directButton.textContent = isDirect ? 'Suggest instead' : 'Edit directly';
  }

  /** A page drawn: what it shows is what was saved. */
  function shown() {
    if (timer) clearTimeout(timer);
    timer = null;
    saved = texts();
    refresh();
  }

  // ---- saving -------------------------------------------------------------------------
  async function saveRound() {
    const page = o.page();
    if (!page) return;
    const now = texts();
    const changed = now.map((text, i) => (text === saved[i] ? null : i)).filter((i): i is number => i !== null);
    if (now.length === saved.length && !changed.length) return;
    const putBack = async (why: string, words: string[]) => {
      o.warn(`${why} What you typed there: ${words.map((w) => `“${clip(w)}”`).join(' ')}`);
      settling = true;
      try { await o.reload(); } finally { settling = false; }
    };
    if (now.length !== saved.length) {
      await putBack('The page\'s paragraphs changed, which the pane does not save, so it is shown as saved.', now.filter((text) => !saved.includes(text)));
      return;
    }
    if (suggesting() || o.cannotWrite()) {
      await putBack(`The page was not changed: ${o.cannotWrite() ?? 'it is the librarian\'s, so a change is suggested'}.`, changed.map((i) => now[i]!));
      return;
    }
    for (const i of changed) {
      const change = textChange(saved[i]!, now[i]!)!;
      const why = await o.save(page.chId, { pIdx: i, off: change.off, len: change.len }, change.expected, change.text, saved[i]!);
      if (o.page()?.chId !== page.chId) return;
      if (why) {
        await putBack(`Your change was not saved: ${why}.`, [now[i]!]);
        return;
      }
      saved[i] = now[i]!;
    }
    settling = true;
    try { await o.settle(); } finally { settling = false; }
  }

  /** What was typed, saved now; resolves once every round started is done. */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    saving = saving.then(saveRound).catch((err: unknown) => {
      o.warn(`Your change was not saved: ${err instanceof Error ? err.message : String(err)}. It is still in the pane; type again to retry.`);
    });
    return saving;
  }

  pane.beforeLeave(async () => {
    if (settling) return;
    if (timer) await flush();
    else await saving;
  });

  // ---- typing -------------------------------------------------------------------------
  // The paragraph a point of the page is in, or null outside the lines.
  const lineOf = (node: Node): Element | null => {
    const elem = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const line = elem?.closest('p');
    return line && line.parentElement === body ? line : null;
  };

  // A range from words in a line to the very start of the next is those words: a triple
  // click selects that way. Anything else across lines is a join, Backspace at a line's
  // start among them.
  function oneLine(range: StaticRange | Range): Range | null {
    const start = lineOf(range.startContainer);
    const end = lineOf(range.endContainer);
    if (!start || !end) return null;
    const live = document.createRange();
    live.setStart(range.startContainer, range.startOffset);
    live.setEnd(range.endContainer, range.endOffset);
    if (start === end) return live;
    const intoEnd = document.createRange();
    intoEnd.setStart(end, 0);
    intoEnd.setEnd(range.endContainer, range.endOffset);
    if (start.nextElementSibling !== end || intoEnd.toString() !== '') return null;
    live.setEnd(start, start.childNodes.length);
    return live.toString() ? live : null;
  }

  body.addEventListener('beforeinput', (e) => {
    if (!editable()) { e.preventDefault(); return; }
    if (REFUSED.test(e.inputType)) { e.preventDefault(); o.warn(STRUCTURE); return; }
    const sel = getSelection();
    const targets = e.getTargetRanges();
    const target = targets[0] ?? (sel?.rangeCount ? sel.getRangeAt(0) : null);
    const range = target ? oneLine(target) : null;
    if (!range || targets.length > 1) { e.preventDefault(); o.warn(STRUCTURE); return; }
    const pasting = e.inputType.startsWith('insertFromPaste');
    const words = pasting || e.inputType === 'insertReplacementText' ? (e.dataTransfer?.getData('text/plain') ?? e.data ?? '') : (e.data ?? '');
    if (/[\r\n]/.test(words)) { e.preventDefault(); o.warn(STRUCTURE); return; }
    const clamped = range.endContainer !== target!.endContainer || range.endOffset !== target!.endOffset;
    if (clamped && sel) { sel.removeAllRanges(); sel.addRange(range); }
    if (suggesting()) {
      e.preventDefault();
      if (e.inputType.startsWith('insert')) o.suggest(words);
      else if (!range.collapsed) o.suggest('');
      else o.warn(LIBRARIANS);
      return;
    }
    // pasted words come in plain, as typed; a selection cut short is typed over by hand
    if (pasting || clamped) {
      e.preventDefault();
      if (e.inputType.startsWith('insert')) document.execCommand('insertText', false, words);
      else document.execCommand('delete');
    }
  });

  // NEO's typography (smart quotes, dashes) answers keys with its own insert, which sends
  // no beforeinput, so on a page that takes suggestions the key is taken first, from the
  // window, as the book takes it on a held page
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!(e.target instanceof Node) || !body.contains(e.target) || !editable() || !suggesting()) return;
    const sel = getSelection();
    if (e.key.length === 1) {
      e.preventDefault();
      o.suggest(e.key);
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (sel && !sel.isCollapsed) o.suggest('');
      else o.warn(LIBRARIANS);
    }
  }, true);

  body.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { flush(); }, SAVE_AFTER);
  });
  // wider once the writer types, not on the click that puts the caret in: a pane that
  // grew under a press would move a link from under the pointer before it lets go
  body.addEventListener('keydown', () => { if (editable()) pane.wide(true); });
  body.addEventListener('focusout', () => { if (timer) flush(); });
  pane.root.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget instanceof Node) || !pane.root.contains(e.relatedTarget)) pane.wide(false);
  });
  window.addEventListener('blur', () => { if (timer) flush(); });

  directButton.addEventListener('click', () => {
    const page = o.page();
    if (!page) return;
    if (direct.has(page.chId)) direct.delete(page.chId);
    else direct.add(page.chId);
    refresh();
    o.tell(direct.has(page.chId) ? 'Editing this page directly until the book closes.' : 'Suggesting on this page again.');
  });

  neo.on('book-open', () => { refresh(); });
  neo.on('book-close', () => {
    direct.clear();
    const done = timer ? flush() : saving;
    refresh();
    return done;
  });

  return {
    shown,
    refresh,
    flush,
    /** For tests and the console. */
    state: () => ({ editable: editable(), suggesting: suggesting(), direct: [...direct], pending: !!timer }),
  };
}
