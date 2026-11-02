// Editing in the Wiki pane: the stored page shown beside the book is edited in place, on
// the browser's own editing (contenteditable), so the writer can put a fact right in their
// world-building without leaving their place in the manuscript. Enter splits a paragraph,
// Backspace and Delete join two, Ctrl+B and Ctrl+I format, a paste comes in through NEO's
// own cleaner (cleanPasteHtml), and undo and redo are the browser's.
//
// On the writer's own pages typing is saved 800 ms after it stops, when the focus leaves
// the page, and before the pane shows another page: the lines are written as a patch of
// blocks by their data-block ids (wiki/edit.ts patchBlocks), so a block the writer did not
// touch keeps its bytes. On the librarian's pages a keystroke opens the pane's suggest
// composer instead, as it does in the book, until the writer chooses Edit directly, which
// lasts for that page until the open book closes.
//
// Block ids are what citations ([[Page#^id]]) point at. A split leaves the id with the
// words the browser keeps, and the new block gets a fresh six-hex id never used on the page
// this session. A join keeps the upper block's id and records the lower's on it as
// data-alias (Join-Keeps-Both-Ids); words joined into an empty block keep their own id.
// The ids are set as attributes after the browser's edit, which the undo stack does not
// record, so after an undo or redo they are worked out again from the lines as they are.
// While the writer edits, the pane asks the host for more room (host API 5's wide).
import { blockKeys, joinedIds, readBlocks, type NowBlock, type Was } from './edit.ts';
import { BLOCK_CLASS, BLOCK_DATA, CHIP, CHIP_SOURCE, INLINE, type ShownPage } from './pane.ts';

// NEO's own cleaner for pasted HTML (app.js), a global of the window
declare function cleanPasteHtml(html: string, dashes?: unknown): string;

interface Pane {
  root: HTMLDivElement;
  body: HTMLDivElement;
  beforeLeave(fn: () => Promise<void>): void;
  wide(on: boolean): void;
}

export interface PaneEditOptions {
  /** The page shown, its HTML as last saved, or null. */
  page(): ShownPage | null;
  /** Why the page shown cannot be written now, or null. */
  cannotWrite(): string | null;
  isLibrarians(id: string): boolean;
  /** The suggest composer opened on the selection, with typed for the selected words. */
  suggest(typed: string): void;
  /** The page's blocks as the pane shows them written as the writer's; resolves with why not, or null once they are. */
  saveBlocks(id: string, now: NowBlock[]): Promise<string | null>;
  /** The marks drawn again on the lines as they are. */
  redraw(): void;
  /** After a round of saves: the marks drawn again, or the page read again where it must be. */
  settle(): Promise<void>;
  /** The page shown again as saved. */
  reload(): Promise<void>;
  tell(text: string): void;
  warn(text: string): void;
}

const SAVE_AFTER = 800;
const STRUCTURE = 'A page in the pane keeps paragraphs, bold and italic. Line breaks inside a paragraph, lists and dropped content are not taken: press Enter for a new paragraph, or paste instead of dropping.';
const SUGGEST_STRUCTURE = 'On the librarian\'s page, typing suggests a change to words within one paragraph. To make, join or format paragraphs, choose Edit directly.';
const LIBRARIANS = 'This is the librarian\'s page: select words and type to suggest a change, or choose Edit directly.';
// what direct editing never takes
const NEVER = /^(?:insertLineBreak|insertOrderedList|insertUnorderedList|insertHorizontalRule|insertLink|insertFromDrop|deleteByDrag|format(?!Bold$|Italic$|Underline$|StrikeThrough$))/;
// what a page that takes suggestions leaves to direct editing
const REFUSED = /^(?:insertParagraph|insertLineBreak|insertOrderedList|insertUnorderedList|insertHorizontalRule|insertLink|insertFromDrop|deleteByDrag|format)/;
const ALIAS_ATTR = /\sdata-alias="([^"]*)"/g;
const ID_ATTR = /\sdata-block="([^"]*)"/g;

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escapeAttr = (text: string) => escapeText(text).replace(/"/g, '&quot;');

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const clip = (text: string, n = 300) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** A line's words, NEO's inline formatting and its locked chips as the page stores them; anything else flattens to its words. */
function innerHtml(node: Node): string {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out += escapeText(child.textContent ?? '');
    else if (child instanceof Element) {
      const source = child.classList.contains(CHIP) ? child.getAttribute(CHIP_SOURCE) : null;
      if (source !== null) out += source;
      else if (child.tagName === 'BR') out += '<br>';
      else if (INLINE.has(child.tagName)) {
        const tag = child.tagName.toLowerCase();
        const inner = innerHtml(child);
        if (inner) out += `<${tag}>${inner}</${tag}>`;
      } else out += innerHtml(child);
    }
  }
  // a break behind words is the engine's placeholder
  return out !== '<br>' ? out.replace(/<br>$/, '') : out;
}

/** The opening tag of a block the pane made, from what the pane shows of it; its ids are put in when it is written. */
function openTag(line: HTMLElement): string {
  const names = [...line.classList].filter((name) => BLOCK_CLASS.test(name));
  const cls = names.length ? ` class="${names.join(' ')}"` : '';
  const data = BLOCK_DATA.filter((key) => key !== 'block' && key !== 'alias' && line.hasAttribute(`data-${key}`))
    .map((key) => ` data-${key}="${escapeAttr(line.getAttribute(`data-${key}`)!)}"`).join('');
  return `<p${cls}${data}>`;
}

const aliasOf = (line: HTMLElement): string[] => (line.dataset.alias ?? '').split(/\s+/).filter(Boolean);
function setAlias(line: HTMLElement, alias: readonly string[]) {
  if (alias.length) line.dataset.alias = alias.join(' ');
  else delete line.dataset.alias;
}

/** A block id as the wiki makes them: six hex digits, which a citation can carry. */
function newBlockId(taken: Set<string>): string {
  let id: string;
  do id = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('');
  while (taken.has(id));
  taken.add(id);
  return id;
}

/** Every id a page's HTML holds, aliases included. */
function idsIn(html: string): Set<string> {
  const ids = new Set([...html.matchAll(ID_ATTR)].map((m) => m[1]!));
  for (const m of html.matchAll(ALIAS_ATTR)) for (const id of m[1]!.split(/\s+/)) if (id) ids.add(id);
  return ids;
}

/** Tags the pane lets a paste keep: NEO's inline formatting and paragraphs, without attributes. */
function allowed(html: string): string {
  const inert = document.createElement('template');
  inert.innerHTML = html;
  const walk = (from: Node): string => [...from.childNodes].map((node) => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
    if (!(node instanceof Element)) return '';
    const inner = walk(node);
    const tag = node.tagName.toLowerCase();
    if (node.tagName === 'P' || INLINE.has(node.tagName)) return inner ? `<${tag}>${inner}</${tag}>` : '';
    return inner;
  }).join('');
  return walk(inert.content);
}

export function startPaneEdit(neo: Pick<NeoApiV5, 'on'>, pane: Pane, o: PaneEditOptions) {
  const { body } = pane;
  // the librarian's pages the writer chose to edit directly, until the open book closes
  const direct = new Set<string>();
  // what each line was when last saved or shown: its block's key and opening tag in the
  // stored page, and what the pane writes of it. A line the pane made has no entry until it
  // is saved. Keys are the stored page's, so a native undo that brings back a line removed
  // and saved is a new block to write, with the opening tag it had.
  const base = new WeakMap<Element, { key: string; open: string; serial: string; id: string; alias: string }>();
  // every id seen on each page this session, so a new block never takes one again
  const used = new Map<string, Set<string>>();
  // the ids the pane made this session: nothing cited one, so a block of one that goes (an
  // undone split, say) leaves no alias
  const made = new Set<string>();
  // a line that took the id of words joined into it while empty: its own id, back on undo
  const took = new WeakMap<Element, string>();
  // the lines as they were after the last edit, for working out where a removed line's ids go
  let prev: { line: HTMLElement; id: string; alias: string[]; empty: boolean }[] = [];
  // the line a native edit began in: the one that keeps its block id when it splits
  let origin: Element | null = null;
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
  const editable = () => !!o.page() && !o.cannotWrite();
  const suggesting = () => {
    const page = o.page();
    return !!page && o.isLibrarians(page.id) && !direct.has(page.id);
  };
  const usedOn = (id: string) => {
    let ids = used.get(id);
    if (!ids) used.set(id, ids = new Set());
    return ids;
  };

  /** The page made editable or not, and the librarian's mode line, as things stand. */
  function refresh() {
    const page = o.page();
    const on = editable();
    body.contentEditable = on ? 'true' : 'false';
    body.setAttribute('aria-label', on ? 'Page text, editable' : 'Page text');
    if (!on && body.contains(document.activeElement)) pane.wide(false);
    mode.hidden = !on || !page || !o.isLibrarians(page.id);
    if (mode.hidden || !page) return;
    const isDirect = direct.has(page.id);
    modeText.textContent = isDirect
      ? 'The librarian\'s page, edited directly: your edits are yours, and the history says so.'
      : 'The librarian\'s page: what you type here is suggested, and the librarian reviews it.';
    directButton.textContent = isDirect ? 'Suggest instead' : 'Edit directly';
  }

  const snapshot = () => {
    prev = lines().map((line) => ({ line, id: line.dataset.block ?? '', alias: aliasOf(line), empty: !line.textContent }));
  };

  /** The lines as written in html, which holds one block for each, in order. */
  function rebase(ls: HTMLElement[], serials: string[], html: string) {
    const stored = readBlocks(html);
    if (stored.length !== ls.length) return;
    ls.forEach((line, i) => base.set(line, { key: stored[i]!.key, open: stored[i]!.open, serial: serials[i]!, id: line.dataset.block ?? '', alias: aliasOf(line).join(' ') }));
  }

  /** A page drawn: what it shows is what was saved. */
  function shown() {
    if (timer) clearTimeout(timer);
    timer = null;
    const page = o.page();
    if (page) for (const id of idsIn(page.html)) usedOn(page.id).add(id);
    rebase(lines(), lines().map(innerHtml), page ? page.html : '');
    snapshot();
    refresh();
  }

  // ---- block ids ----------------------------------------------------------------------
  // A line the pane made, or a copy of another's attributes by a split, gets an id of its
  // own: the line the edit began in keeps the id with the words, a copy never shares it,
  // nor the aliases that went with it.
  function fixIds(taken: Set<string>) {
    const ls = lines();
    for (const line of ls) if (line.dataset.block) taken.add(line.dataset.block);
    const uses = ls.some((line) => line.dataset.block);
    const rank = (line: Element) => (base.has(line) ? 0 : line === origin ? 1 : 2);
    const owner = new Map<string, Element>();
    for (const line of ls) {
      const id = line.dataset.block;
      const holder = id ? owner.get(id) : undefined;
      if (id && (!holder || rank(line) < rank(holder))) owner.set(id, line);
    }
    for (const line of ls) {
      if (base.has(line)) continue;
      const id = line.dataset.block;
      if (id ? owner.get(id) !== line : uses) {
        line.dataset.block = newBlockId(taken);
        made.add(line.dataset.block);
        delete line.dataset.alias;
      }
    }
  }

  // After an edit that made or removed lines, an undo or a redo: each line's ids as the
  // rules give them for the lines as they now are. Only an id the page had on disk, which a
  // citation could name, is kept as an alias.
  function settleIds() {
    const page = o.page();
    if (!page) return;
    const ls = lines();
    const live = new Set(ls);
    // an undone join: the line that took the words' id gives it back to them
    for (const line of ls) {
      const own = took.get(line);
      if (own !== undefined && ls.some((other) => other !== line && other.dataset.block === line.dataset.block)) {
        line.dataset.block = own;
        took.delete(line);
      }
    }
    // an alias is only an alias while no line holds that id
    const ids = new Set(ls.map((line) => line.dataset.block).filter((id): id is string => !!id));
    for (const line of ls) {
      const alias = aliasOf(line);
      const kept = alias.filter((id) => !ids.has(id));
      if (kept.length !== alias.length) setAlias(line, kept);
    }
    const taken = usedOn(page.id);
    fixIds(taken);
    // the ids of the lines the edit removed
    const was: Was[] = prev.map((p) => ({ id: p.id, alias: p.alias, empty: p.empty, live: live.has(p.line) }));
    const cited = new Set([...idsIn(page.html)].filter((id) => !made.has(id)));
    for (const [i, got] of joinedIds(was, cited)) {
      const line = prev[i]!.line;
      if (got.id !== (line.dataset.block ?? '')) {
        if (!took.has(line)) took.set(line, line.dataset.block ?? '');
        line.dataset.block = got.id;
      }
      setAlias(line, got.alias);
    }
  }

  // ---- saving -------------------------------------------------------------------------
  async function saveRound() {
    const page = o.page();
    if (!page) return;
    const ls = lines();
    const serials = ls.map(innerHtml);
    const stored = blockKeys(page.html);
    const keys = new Set(stored);
    const claimed = new Set<string>();
    const now: NowBlock[] = ls.map((line, i) => {
      const was = base.get(line);
      const id = line.dataset.block ?? '';
      const alias = aliasOf(line).join(' ');
      // a stored block is written once; a second line holding it is a new block
      if (was && keys.has(was.key) && !claimed.has(was.key)) {
        claimed.add(was.key);
        return { key: was.key, id, alias, open: '', inner: serials[i]!, touched: was.serial !== serials[i] || was.id !== id || was.alias !== alias };
      }
      return { key: null, id, alias, open: was?.open ?? openTag(line), inner: serials[i]!, touched: true };
    });
    if (now.length === stored.length && now.every((b, i) => b.key === stored[i] && !b.touched)) return;
    const putBack = async (why: string, words: string[]) => {
      o.warn(`${why} What you typed there: ${words.map((w) => `“${clip(w)}”`).join(' ')}`);
      settling = true;
      try { await o.reload(); } finally { settling = false; }
    };
    const typed = ls.filter((_, i) => now[i]!.touched).map((line) => line.textContent ?? '');
    if (suggesting() || o.cannotWrite()) {
      await putBack(`The page was not changed: ${o.cannotWrite() ?? 'it is the librarian\'s, so a change is suggested'}.`, typed);
      return;
    }
    const why = await o.saveBlocks(page.id, now);
    if (o.page()?.id !== page.id) return;
    if (why) {
      await putBack(`Your change was not saved: ${why}.`, typed);
      return;
    }
    // what was saved is what the lines read when the round began, not what they read now
    rebase(ls, serials, o.page()!.html);
    settling = true;
    try { await o.settle(); } finally { settling = false; }
  }

  /** What was typed, saved now; resolves once every round started is done. */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    saving = saving.then(saveRound).catch((err: unknown) => {
      console.warn('hoard: wiki pane: a save did not finish', err);
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

  // Pasted HTML comes in through NEO's own cleaner and only the tags the pane keeps; with
  // no HTML, the lines of the plain text are paragraphs.
  function paste(e: InputEvent) {
    const html = e.dataTransfer?.getData('text/html') ?? '';
    const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
    let kept: string;
    if (html && typeof cleanPasteHtml === 'function') kept = allowed(cleanPasteHtml(html));
    else {
      // the first line joins the words at the caret with its spaces as they are, which the
      // engine would drop at a paragraph's edge; each line after it is a paragraph
      const [first, ...rest] = text.split(/\r\n|\r|\n/);
      kept = (first ? `<span style="white-space: pre-wrap">${escapeText(first)}</span>` : '')
        + rest.filter((row) => row.trim()).map((row) => `<p>${escapeText(row)}</p>`).join('');
    }
    if (kept) document.execCommand('insertHTML', false, kept);
  }

  // Direct editing is the browser's own: Enter, Backspace and Delete across blocks, bold and
  // italic, undo. What is left to do afterwards is the blocks' ids (settleIds).
  function editDirectly(e: InputEvent) {
    if (NEVER.test(e.inputType)) { e.preventDefault(); o.warn(STRUCTURE); return; }
    const sel = getSelection();
    origin = sel?.rangeCount ? lineOf(sel.getRangeAt(0).startContainer) : null;
    if (e.inputType.startsWith('insertFromPaste')) { e.preventDefault(); paste(e); return; }
    // a triple click selects to the very start of the next block, and typing over that
    // would join the two: the selection is the words alone
    const target = e.getTargetRanges()[0];
    const range = target ? oneLine(target) : null;
    if (!range || !target || (range.endContainer === target.endContainer && range.endOffset === target.endOffset)) return;
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    if (e.inputType === 'insertText' || e.inputType.startsWith('delete')) {
      e.preventDefault();
      if (e.inputType.startsWith('insert')) document.execCommand('insertText', false, e.data ?? '');
      else document.execCommand('delete');
    }
  }

  body.addEventListener('beforeinput', (e) => {
    if (!editable()) { e.preventDefault(); return; }
    if (!suggesting()) { editDirectly(e); return; }
    if (REFUSED.test(e.inputType)) { e.preventDefault(); o.warn(SUGGEST_STRUCTURE); return; }
    const sel = getSelection();
    const targets = e.getTargetRanges();
    const target = targets[0] ?? (sel?.rangeCount ? sel.getRangeAt(0) : null);
    const range = target ? oneLine(target) : null;
    if (!range || targets.length > 1) { e.preventDefault(); o.warn(SUGGEST_STRUCTURE); return; }
    const pasting = e.inputType.startsWith('insertFromPaste');
    const words = pasting || e.inputType === 'insertReplacementText' ? (e.dataTransfer?.getData('text/plain') ?? e.data ?? '') : (e.data ?? '');
    const clamped = range.endContainer !== target!.endContainer || range.endOffset !== target!.endOffset;
    if (clamped && sel) { sel.removeAllRanges(); sel.addRange(range); }
    e.preventDefault();
    if (/[\r\n]/.test(words)) { o.warn(SUGGEST_STRUCTURE); return; }
    if (e.inputType.startsWith('insert')) o.suggest(words);
    else if (!range.collapsed) o.suggest('');
    else o.warn(LIBRARIANS);
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

  // The window-wide chords that act on the open book (placeholder, darling, footnote,
  // snapshot, fullscreen: app.js, a document listener) are not heard from the pane: seen
  // first, from the window, they stop here. So are redo's (Ctrl+Shift+Z, Ctrl+Y), which
  // NEO takes for the book's structural redo while it has one waiting; in the pane they
  // are the engine's redo of the pane's own edits.
  window.addEventListener('keydown', (e) => {
    if (!(e.target instanceof Node) || !body.contains(e.target) || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const chord = e.shiftKey ? ['KeyX', 'KeyD', 'KeyN', 'KeyZ'].includes(e.code) : e.code === 'KeyS' || e.code === 'KeyY' || e.key === 'Enter';
    if (chord) e.stopPropagation();
  }, true);

  body.addEventListener('input', (e) => {
    const kind = (e as InputEvent).inputType ?? '';
    if (!suggesting()) {
      const ls = lines();
      const moved = ls.length !== prev.length || ls.some((line, i) => prev[i]!.line !== line);
      if (moved || kind.startsWith('history')) {
        settleIds();
        o.redraw();
      }
    }
    origin = null;
    snapshot();
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
    if (direct.has(page.id)) direct.delete(page.id);
    else direct.add(page.id);
    refresh();
    o.tell(direct.has(page.id) ? 'Editing this page directly until the book closes.' : 'Suggesting on this page again.');
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
