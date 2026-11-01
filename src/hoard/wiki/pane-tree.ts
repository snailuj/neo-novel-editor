// The Pages tree at the top of the wiki pane: the library's wiki/ and sources/ folders, so
// a page can be opened beside the book, made, renamed or moved without leaving it. What it
// draws and what each gesture does are worked out in wiki/tree.ts, whose header holds the
// state machine this view follows; this file is the DOM and the calls to the main half.
//
// The tree folds away (it starts folded, so the page shown keeps the room) and reads the
// list when it unfolds, after each change it makes, and on Refresh. Rows are buttons in
// nested lists, one row in the Tab order at a time (with its Rename and Move); arrows walk
// the rows, F2 renames. A rename goes through pages/window.ts, which rewrites every link,
// the open book's through the host's replace. Nothing here moves the focus unless it is in
// the pane already.
import { claim } from '../keys.ts';
import { renamePage, type PagesWindow } from '../pages/window.ts';
import { titleOf, type Tree } from '../pages/identity.ts';
import {
  buildTree, CLOSED, explain, folderOf, foldersIn, judge, newPageHtml, place, step, visibleRows,
  type Ask, type Editor, type EditorEvent, type Folder, type Listed, type Row,
} from './tree.ts';

export interface TreeHost {
  /** The page shown in the pane. */
  open(id: string): Promise<void>;
  /** A page renamed or moved: the trail follows it and the page shown is read again. */
  renamed(from: string, to: string): Promise<void>;
  /** Each list read, which the pane's links on a stored page resolve against. */
  listed(entries: Listed[]): void;
  /** The pane's section: the tree takes the focus only from inside it. */
  paneRoot: HTMLElement;
}

type Neo = PagesWindow & Pick<NeoApiV5, 'on'>;

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
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const why = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^plugin \S+: \S+ failed: /, '');

const ACTION: Record<Ask['op'], { label: string; busy: string }> = {
  rename: { label: 'Rename page', busy: 'Renaming…' },
  move: { label: 'Move page', busy: 'Moving…' },
  new: { label: 'Make page', busy: 'Making…' },
};

export function startPagesTree(neo: Neo, host: TreeHost) {
  let entries: Listed[] = [];
  let roots: Folder[] = buildTree([]);
  let rows: Row[] = [];
  const open = new Set<string>(['wiki', 'sources']);
  let unfolded = false;
  let listedOnce = false;
  let reading: Promise<void> | null = null;
  let generation = 0;
  // the row in the Tab order, and the page shown in the pane
  let active = 'wiki';
  let shownId: string | null = null;
  let editor: Editor = CLOSED;

  const element = el('section', 'hoard-tree');
  const head = el('div', 'hoard-tree-head');
  const fold = button('hoard-tree-fold', '');
  const chevron = el('span', 'hoard-tree-chevron', '▸');
  chevron.setAttribute('aria-hidden', 'true');
  fold.append(chevron, document.createTextNode('Pages'));
  fold.setAttribute('aria-expanded', 'false');
  fold.setAttribute('aria-controls', 'hoard-tree-body');
  const newButton = button('hoard-tree-new', 'New page');
  const refreshButton = button('hoard-tree-refresh', 'Refresh');
  head.append(fold, newButton, refreshButton);
  const bodyEl = el('div', 'hoard-tree-body');
  bodyEl.id = 'hoard-tree-body';
  const status = el('p', 'hoard-status hoard-tree-status');
  status.setAttribute('role', 'status');
  const alert = el('p', 'hoard-alert hoard-tree-alert');
  alert.setAttribute('role', 'alert');
  const list = el('ul', 'hoard-tree-list');
  list.setAttribute('aria-label', 'Pages in your library');
  const empty = el('p', 'hoard-tree-empty', 'No pages yet. Pages are files in the wiki and sources folders of your library. Choose New page to make one.');
  bodyEl.append(status, alert, list, empty);
  element.append(head, bodyEl);

  // ---- the row editor: one form, moved to the row it works on -------------------------
  const form = el('form', 'hoard-tree-editor');
  const label = el('label', 'hoard-label');
  const input = el('input', 'hoard-tree-input');
  input.id = 'hoard-tree-input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  label.htmlFor = input.id;
  const hint = el('p', 'hoard-tree-hint');
  hint.id = 'hoard-tree-hint';
  const error = el('p', 'hoard-tree-error');
  error.id = 'hoard-tree-error';
  error.setAttribute('role', 'alert');
  const folders = el('datalist');
  folders.id = 'hoard-tree-folders';
  const submit = el('button', 'hoard-tree-submit');
  submit.type = 'submit';
  const cancel = button('hoard-tree-cancel', 'Cancel');
  const actions = el('div', 'hoard-tree-actions');
  actions.append(submit, cancel);
  form.append(label, input, error, hint, folders, actions);

  // The writer is in the pane while the focus is there, or after a click there that left
  // the focus nowhere (a button takes no focus from a click on a Mac): the tree may then
  // move the focus. A key or a click anywhere else ends it.
  let lastGestureInPane = false;
  const gesture = (e: Event) => { lastGestureInPane = e.target instanceof Node && host.paneRoot.contains(e.target); };
  document.addEventListener('pointerdown', gesture, true);
  document.addEventListener('keydown', gesture, true);
  const focusInPane = () => host.paneRoot.contains(document.activeElement)
    || (lastGestureInPane && (!document.activeElement || document.activeElement === document.body));
  const rowButton = (key: string) => list.querySelector<HTMLButtonElement>(`.hoard-tree-name[data-key="${CSS.escape(key)}"]`);
  // the row of a key, or of the nearest folder above it that is drawn
  const nearestRow = (key: string | null): HTMLButtonElement | null => {
    for (let k = key; k; k = k.includes('/') ? k.slice(0, k.lastIndexOf('/')) : null) {
      const b = rowButton(k);
      if (b) return b;
    }
    return null;
  };
  const askKey = (ask: Ask) => (ask.op === 'new' ? (ask.folder ? `${ask.tree}/${ask.folder}` : ask.tree) : ask.id);
  // the folders a row's key sits in, opened, so the row is drawn: wiki/A/B.html opens wiki and wiki/A
  const reveal = (key: string) => {
    const parts = key.split('/');
    for (let n = 1; n < parts.length; n++) open.add(parts.slice(0, n).join('/'));
  };

  // ---- drawing --------------------------------------------------------------------------
  const drawEditor = () => {
    const at = editor.state === 'closed' ? null : editor;
    if (!at) {
      form.remove();
      return;
    }
    const { ask } = at;
    const pending = at.state === 'pending';
    const err = at.state === 'open' ? at.error : null;
    const name = ask.op === 'new' ? '' : entries.find((e) => e.id === ask.id)?.title ?? ask.id;
    const tree: Tree = ask.op === 'new' ? ask.tree : (ask.id.startsWith('sources/') ? 'sources' : 'wiki');
    label.textContent = ask.op === 'rename' ? `New title for “${name}”`
      : ask.op === 'move' ? `Folder in ${tree} to move “${name}” to`
      : `Title of the new page in ${place(ask.tree, ask.folder)}`;
    hint.textContent = ask.op === 'move' ? `Pick a folder or type a new one, such as People/Family. Leave it empty for the top of ${tree}. Esc cancels.` : 'Enter saves, Esc cancels.';
    if (ask.op === 'move') {
      input.setAttribute('list', folders.id);
      folders.replaceChildren(...foldersIn(roots, tree).filter(Boolean).map((f) => { const o = el('option'); o.value = f; return o; }));
    } else {
      input.removeAttribute('list');
    }
    if (input.value !== ask.value) input.value = ask.value;
    input.readOnly = pending;
    if (pending) input.setAttribute('aria-busy', 'true');
    else input.removeAttribute('aria-busy');
    error.textContent = err ?? '';
    if (err) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', err ? `${error.id} ${hint.id}` : hint.id);
    submit.textContent = pending ? ACTION[ask.op].busy : ACTION[ask.op].label;
    submit.setAttribute('aria-disabled', String(pending));
    cancel.setAttribute('aria-disabled', String(pending));
    // the form sits under the row it works on; for a new page, under its folder's row
    const holder = rowButton(askKey(ask))?.closest('li');
    if (holder) holder.querySelector(':scope > .hoard-tree-row')!.after(form);
    else form.remove();
  };

  const draw = () => {
    const hadFocus = element.contains(document.activeElement);
    const focusedKey = (document.activeElement as HTMLElement | null)?.closest?.('li')?.dataset['key'] ?? null;
    const inForm = form.contains(document.activeElement);
    rows = visibleRows(roots, open);
    if (!rows.some((r) => r.key === active)) active = rows.find((r) => r.key === folderOf(active))?.key ?? rows[0]?.key ?? 'wiki';
    // nested lists, so each row's level is the list it is in
    const stack: HTMLUListElement[] = [list];
    const items: HTMLLIElement[] = [];
    list.replaceChildren();
    for (const r of rows) {
      while (stack.length > r.depth + 1) stack.pop();
      const li = el('li', `hoard-tree-item hoard-tree-${r.kind}`);
      li.dataset['key'] = r.key;
      const line = el('div', 'hoard-tree-row');
      line.style.setProperty('--depth', String(r.depth));
      const name = button('hoard-tree-name', r.name);
      name.dataset['key'] = r.key;
      name.tabIndex = r.key === active ? 0 : -1;
      line.append(name);
      if (r.kind === 'folder') {
        name.setAttribute('aria-expanded', String(r.open));
        const count = el('span', 'hoard-tree-count', String(r.count));
        count.setAttribute('aria-hidden', 'true');
        line.append(count);
      } else {
        if (r.key === shownId) name.setAttribute('aria-current', 'page');
        for (const [kind, text] of [['rename', 'Rename'], ['move', 'Move']] as const) {
          const act = button(`hoard-tree-act hoard-tree-${kind}`, text);
          act.setAttribute('aria-label', `${text} ${r.name}`);
          act.dataset['act'] = kind;
          act.dataset['key'] = r.key;
          act.tabIndex = r.key === active ? 0 : -1;
          line.append(act);
        }
      }
      li.append(line);
      stack[stack.length - 1]!.append(li);
      items.push(li);
      if (r.kind === 'folder' && r.open) {
        const sub = el('ul', 'hoard-tree-sub');
        li.append(sub);
        stack.push(sub);
      }
    }
    empty.hidden = !listedOnce || entries.length > 0;
    drawEditor();
    if (!hadFocus) return;
    if (inForm && form.isConnected) input.focus();
    else if (focusedKey && !element.contains(document.activeElement)) nearestRow(focusedKey)?.focus();
  };

  const setActive = (key: string) => {
    if (key === active) return;
    for (const b of list.querySelectorAll<HTMLButtonElement>(`[data-key="${CSS.escape(active)}"]`)) b.tabIndex = -1;
    active = key;
    for (const b of list.querySelectorAll<HTMLButtonElement>(`[data-key="${CSS.escape(active)}"]`)) b.tabIndex = 0;
  };

  const focusRow = (key: string) => {
    setActive(key);
    rowButton(key)?.focus();
  };

  // ---- the list -------------------------------------------------------------------------
  const read = async (): Promise<void> => {
    const mine = ++generation;
    status.textContent = 'Reading pages…';
    refreshButton.setAttribute('aria-disabled', 'true');
    try {
      const listed = (await neo.invoke('pages.list')) as Listed[];
      if (mine !== generation) return;
      entries = listed;
      roots = buildTree(entries);
      listedOnce = true;
      host.listed(entries);
      alert.textContent = '';
      status.textContent = '';
      // a field on a page the list no longer has goes, and the alert says why
      const ask = editor.state === 'closed' ? null : editor.ask;
      if (ask && ask.op !== 'new' && !entries.some((e) => e.id === ask.id)) {
        const v = judge(ask, entries);
        if (v.kind === 'refused') alert.textContent = v.message;
        console.warn('hoard: pages tree: refused', { op: ask.op, code: 'missing', id: ask.id });
        dispatch({ type: 'vanished' });
      }
      draw();
    } catch (err) {
      if (mine !== generation) return;
      status.textContent = '';
      alert.textContent = `The pages could not be read: ${why(err)}. Choose Refresh to try again.`;
      console.warn('hoard: pages tree: the list did not read', err);
    } finally {
      if (mine === generation) refreshButton.setAttribute('aria-disabled', 'false');
    }
  };
  /** The list read again; a second call while one reads waits for that one. */
  const refresh = (): Promise<void> => {
    if (!reading) reading = read().finally(() => { reading = null; });
    return reading;
  };

  const setFolded = (folded: boolean) => {
    unfolded = !folded;
    fold.setAttribute('aria-expanded', String(unfolded));
    chevron.textContent = unfolded ? '▾' : '▸';
    bodyEl.hidden = folded;
    newButton.hidden = folded;
    refreshButton.hidden = folded;
    if (unfolded) refresh().catch(() => {});
  };

  // ---- the row editor -------------------------------------------------------------------
  const origin = (ask: Ask) => (ask.op === 'new' ? newButton : rowButton(ask.id));

  const settle = async (ask: Ask, verdict: { tree: Tree; path: string }) => {
    const to = `${verdict.tree}/${verdict.path}`;
    // told once the list is read again, which clears the lines
    let said = '';
    let left = '';
    let renamed: { from: string; to: string } | null = null;
    try {
      if (ask.op === 'new') {
        await neo.invoke('pages.create', { tree: verdict.tree, path: verdict.path, html: newPageHtml() });
        console.info('hoard: pages tree: made', { id: to });
        said = `Made the page “${ask.value}” in ${place(verdict.tree, folderOf(verdict.path))}.`;
      } else {
        const done = await renamePage(neo, ask.id, verdict.path);
        console.info(`hoard: pages tree: ${ask.op === 'rename' ? 'renamed' : 'moved'}`, { from: ask.id, to: done.id, files: done.rewrittenFiles, links: done.rewrittenLinks, inBook: done.applied, refused: done.refused.length, skipped: done.skipped });
        const was = titleOf(ask.id);
        const changed = [
          done.rewrittenLinks ? `${plural(done.rewrittenLinks, 'link')} in ${plural(done.rewrittenFiles, 'file')}` : '',
          done.applied ? `${plural(done.applied, 'link')} in this book` : '',
        ].filter(Boolean);
        said = ask.op === 'rename'
          ? `Renamed “${was}” to “${ask.value}”.${changed.length ? ` Changed ${changed.join(' and ')}.` : ''}`
          : `Moved “${was}” to ${place(verdict.tree, folderOf(verdict.path))}.`;
        const kept = [
          done.refused.length ? `${plural(done.refused.length, 'link')} in this book still say [[${was}]], because the book could not take the change there` : '',
          done.skipped ? `${plural(done.skipped, 'link')} in other files still say [[${was}]], because formatting runs through them` : '',
        ].filter(Boolean);
        left = kept.length ? `${kept.join('; ')}. Change them to [[${ask.value}]] by hand.` : '';
        renamed = { from: ask.id, to: done.id };
      }
    } catch (err) {
      const hadFocus = focusInPane();
      await refresh();
      const told = explain(ask, entries, err);
      console.warn('hoard: pages tree: refused', { op: ask.op, code: told.code, message: told.message });
      dispatch({ type: 'refused', message: told.message }, hadFocus);
      return;
    }
    const hadFocus = focusInPane();
    editor = step(editor, { type: 'done' }, entries).editor;
    reveal(to);
    active = to;
    await refresh();
    // after the list, so the page read again resolves its links by the new title
    if (renamed) await host.renamed(renamed.from, renamed.to);
    status.textContent = said;
    alert.textContent = left;
    if (hadFocus) focusRow(to);
    if (ask.op === 'new') await host.open(to);
  };

  /** One event through the table; the focus moves only when it is in the pane (or `focus` says it was). */
  function dispatch(e: EditorEvent, focus = focusInPane()) {
    const was = editor;
    const next = step(editor, e, entries);
    editor = next.editor;
    const opened = e.type === 'start' && was.state === 'closed';
    // the focus leaves the field before the field goes, so it never falls to the page's body
    if (focus && was.state !== 'closed') {
      if (next.effect === 'focus-origin') origin(was.ask)?.focus();
      if (next.effect === 'focus-parent') nearestRow(askKey(was.ask))?.focus();
    }
    if (opened || next.effect === 'busy') {
      const key = askKey((editor as Exclude<Editor, { state: 'closed' }>).ask);
      reveal(key);
      if (e.type === 'start' && e.ask.op === 'new') open.add(key);
      draw();
    } else {
      drawEditor();
    }
    if (next.effect === 'busy') status.textContent = 'Finish or cancel the open field first.';
    const v = next.verdict;
    if (was.state !== 'closed' && v?.kind === 'refused') console.warn('hoard: pages tree: refused', { op: was.ask.op, code: v.code, message: v.message });
    if (was.state !== 'closed' && v?.kind === 'same') {
      const name = was.ask.op === 'new' ? was.ask.value : titleOf(was.ask.id);
      status.textContent = was.ask.op === 'move' ? `“${name}” is already in that folder.` : `“${name}” keeps its title.`;
    }
    if (was.state !== 'closed' && next.effect === 'send' && v?.kind === 'send') {
      settle(was.ask, v).catch((err: unknown) => console.warn('hoard: pages tree: a change did not settle', err));
    }
    if (!focus) return;
    if (next.effect === 'focus-field' || next.effect === 'busy') {
      input.focus();
      if (opened) input.select();
    }
  }

  const startOn = (op: 'rename' | 'move', key: string) => {
    const entry = entries.find((x) => x.id === key);
    if (!entry) return;
    setActive(key);
    dispatch({ type: 'start', ask: { op, id: key, value: op === 'rename' ? entry.title : folderOf(entry.path) } });
  };

  // the folder of the row the writer is on, else the top of wiki
  const folderHere = (): { tree: Tree; folder: string } => {
    const r = rows.find((x) => x.key === active);
    if (!r) return { tree: 'wiki', folder: '' };
    return { tree: r.tree, folder: r.kind === 'folder' ? r.path : folderOf(r.path) };
  };

  // ---- events ---------------------------------------------------------------------------
  fold.addEventListener('click', () => setFolded(unfolded));
  refreshButton.addEventListener('click', () => {
    if (refreshButton.getAttribute('aria-disabled') === 'true') return;
    refresh().catch(() => {});
  });
  newButton.addEventListener('click', () => {
    const { tree, folder } = folderHere();
    dispatch({ type: 'start', ask: { op: 'new', tree, folder, value: '' } });
  });

  list.addEventListener('focusin', (e) => {
    const key = (e.target as HTMLElement).dataset?.['key'];
    if (key && !form.contains(e.target as Node)) setActive(key);
  });
  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || form.contains(b) || !b.dataset['key']) return;
    const key = b.dataset['key'];
    const act = b.dataset['act'];
    if (act === 'rename' || act === 'move') {
      startOn(act, key);
      return;
    }
    const r = rows.find((x) => x.key === key);
    if (!r) return;
    setActive(key);
    if (r.kind === 'folder') {
      if (r.open) open.delete(key);
      else open.add(key);
      draw();
    } else {
      host.open(key).catch((err: unknown) => console.warn('hoard: pages tree: the page did not open', err));
    }
  });
  list.addEventListener('keydown', (e) => {
    const b = e.target as HTMLElement;
    if (!b.classList.contains('hoard-tree-name') || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = rows.findIndex((r) => r.key === b.dataset['key']);
    const r = rows[at];
    if (!r) return;
    const go = (to: Row | undefined) => { if (to) focusRow(to.key); };
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': go(rows[at + 1]); break;
      case 'ArrowUp': go(rows[at - 1]); break;
      case 'Home': go(rows[0]); break;
      case 'End': go(rows[rows.length - 1]); break;
      case 'ArrowRight':
        if (r.kind === 'folder' && !r.open) { open.add(r.key); draw(); } else if (r.kind === 'folder') go(rows[at + 1]?.parent === r.key ? rows[at + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (r.kind === 'folder' && r.open) { open.delete(r.key); draw(); } else if (r.parent) go(rows.find((x) => x.key === r.parent));
        break;
      case 'F2':
        if (r.kind === 'page') startOn('rename', r.key);
        break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (submit.getAttribute('aria-disabled') === 'true') return;
    dispatch({ type: 'submit' });
  });
  input.addEventListener('input', () => dispatch({ type: 'input', value: input.value }));
  input.addEventListener('blur', (e) => {
    // leaving for the form's own buttons is not leaving the field
    if (e.relatedTarget instanceof Node && form.contains(e.relatedTarget)) return;
    dispatch({ type: 'blur' });
  });
  // NEO takes Esc in a side pane on the document's way down and goes back to the page, so
  // the field hears it first, from the window. While a request is in flight Esc cancels
  // nothing, and NEO's own Esc stands.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || e.target !== input || editor.state !== 'open') return;
    claim(e);
    dispatch({ type: 'cancel' });
  }, true);
  cancel.addEventListener('click', () => {
    if (cancel.getAttribute('aria-disabled') === 'true') return;
    dispatch({ type: 'cancel' });
  });

  neo.on('book-open', () => { if (unfolded) refresh().catch(() => {}); });
  setFolded(true);
  draw();

  return {
    element,
    refresh,
    /** The stored page the pane shows, marked on its row; null for none. */
    markShown(id: string | null) {
      shownId = id;
      for (const b of list.querySelectorAll('[aria-current]')) b.removeAttribute('aria-current');
      if (id) rowButton(id)?.setAttribute('aria-current', 'page');
    },
    /** For tests and the console. */
    state: () => structuredClone({ unfolded, open: [...open], active, editor, pages: entries.length }),
  };
}
