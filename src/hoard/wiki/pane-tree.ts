// The Pages tab of the left pane: the library's wiki/ and sources/ folders, so a page can be
// opened in the page column beside the book, made, renamed or moved without leaving the book.
// What it draws and what each gesture does are worked out in wiki/tree.ts, whose header holds
// the state machine this view follows; this file is the DOM and the calls to the main half.
//
// The tree reads the list when the Pages tab first shows after a book opens, after each change
// it makes, and on Refresh. A filter above it narrows it to the pages whose titles hold the
// words typed, with the folders above them open. Rows are full-width buttons in nested lists,
// one in the Tab order at a time; arrows walk them, F2 renames, and a right-click, Shift+F10
// or the Menu key opens a row's menu (NEO's own). A rename goes through pages/window.ts,
// which rewrites every link, the open book's through the host's replace. Nothing here moves
// the focus unless it is in the tab already, or the writer asked for the tree (reveal, edit).
import { claim } from '../keys.ts';
import { renamePage, type PagesWindow } from '../pages/window.ts';
import { titleOf, type Tree } from '../pages/identity.ts';
import { t } from '../say.ts';
import {
  allFolders, buildTree, CLOSED, explain, filterPages, folderOf, foldersIn, judge, newPageHtml, place, rowLabel, rowName,
  sharedReads, step, visibleRows, type Ask, type Editor, type EditorEvent, type Folder, type Listed, type Row,
} from './tree.ts';

// NEO's own small menu (app.js), a global of the window: resolves with the value chosen, or null
declare function popMenu(x: number, y: number, items: { label: string; value: string }[], o?: { from?: Element | null }): Promise<string | null>;

export interface TreeHost {
  /** The page shown in the column. */
  open(id: string): Promise<void>;
  /**
   * Before a rename or move: what was typed in the page shown is saved, and later saves
   * wait until renamed is told (or the release is called, when the change fails), so
   * nothing typed is written under an id that is gone.
   */
  hold(): Promise<() => void>;
  /** A page renamed or moved: the trail follows it and the page shown is read again. */
  renamed(from: string, to: string): Promise<void>;
  /** A page made, renamed or moved: whatever draws links by the pages' titles reads them again. */
  changed(): void;
  /** How many times the writer has gone to a page in the column: one made opens only if none since. */
  moves(): number;
  /** The tab's panel: the tree takes the focus only from inside it. */
  paneRoot: HTMLElement;
  /** The left pane opened on the Pages tab. */
  show(): void;
}

type Neo = PagesWindow & Pick<NeoApiV6, 'on'>;

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
  // the words filtered by, and which folders of the filtered tree are open (all, as it starts)
  let query = '';
  let filterOpen = new Set<string>();
  let listedOnce = false;
  // the list has not been read since the book opened
  let stale = true;
  let generation = 0;
  // the row in the Tab order, and the page shown in the column
  let active = 'wiki';
  let shownId: string | null = null;
  let editor: Editor = CLOSED;

  const element = el('section', 'hoard-tree');
  const head = el('div', 'hoard-tree-head');
  const newButton = button('hoard-tree-new', t('New page'));
  const refreshButton = button('hoard-tree-refresh', t('Refresh'));
  head.append(newButton, refreshButton);
  const filterLabel = el('label', 'hoard-tree-filter');
  const filter = el('input', 'hoard-tree-filter-input');
  filter.type = 'search';
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  filterLabel.append(el('span', '', t('Filter')), filter);
  const bodyEl = el('div', 'hoard-tree-body');
  const status = el('p', 'hoard-status hoard-tree-status');
  status.setAttribute('role', 'status');
  const alert = el('p', 'hoard-alert hoard-tree-alert');
  alert.setAttribute('role', 'alert');
  const list = el('ul', 'hoard-tree-list');
  list.setAttribute('aria-label', 'Pages in your library');
  const empty = el('p', 'hoard-tree-empty', 'No pages yet. Pages are files in the wiki and sources folders of your library. Choose New page to make one.');
  const none = el('p', 'hoard-tree-empty');
  bodyEl.append(status, alert, list, empty, none);
  element.append(head, filterLabel, bodyEl);

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

  // The writer is in the tab while the focus is there, or after a click there that left
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
  const filtering = () => query.trim() !== '';
  // the folders open in the tree drawn: the writer's, or the filtered tree's own
  const openNow = () => (filtering() ? filterOpen : open);
  // the folders a row's key sits in, opened, so the row is drawn: wiki/A/B.html opens wiki and wiki/A
  const reveal = (key: string) => {
    const parts = key.split('/');
    for (let n = 1; n < parts.length; n++) openNow().add(parts.slice(0, n).join('/'));
  };
  // the pages that match, their folders only: a tree with none goes too
  const matched = () => buildTree(filterPages(entries, query)).filter((r) => r.count > 0);

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
    // the form sits under the row it works on; for a new page, under its folder's row. Moved
    // only when elsewhere: a move takes the focus out of the field, even onto the same spot.
    const row = rowButton(askKey(ask));
    if (!row) form.remove();
    else if (row.nextElementSibling !== form) row.after(form);
  };

  const draw = () => {
    const hadFocus = element.contains(document.activeElement);
    const focusedKey = (document.activeElement as HTMLElement | null)?.closest?.('li')?.dataset['key'] ?? null;
    const inForm = form.contains(document.activeElement);
    rows = filtering() ? visibleRows(matched(), filterOpen) : visibleRows(roots, open);
    if (!rows.some((r) => r.key === active)) active = rows.find((r) => r.key === folderOf(active))?.key ?? rows[0]?.key ?? 'wiki';
    // nested lists, so each row's level is the list it is in
    const stack: HTMLUListElement[] = [list];
    const items: HTMLLIElement[] = [];
    list.replaceChildren();
    for (const r of rows) {
      while (stack.length > r.depth + 1) stack.pop();
      const li = el('li', `hoard-tree-item hoard-tree-${r.kind}${r.parent === null ? ' hoard-tree-root' : ''}`);
      li.dataset['key'] = r.key;
      // the whole row is the button: a chevron's slot, the name in two lines at most, a count
      const name = button('hoard-tree-name', '');
      name.dataset['key'] = r.key;
      name.style.setProperty('--depth', String(r.depth));
      name.tabIndex = r.key === active ? 0 : -1;
      name.title = rowName(r);
      const chevron = el('span', 'hoard-tree-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      name.append(chevron, el('span', 'hoard-tree-label', rowName(r)));
      if (r.kind === 'folder') {
        name.setAttribute('aria-expanded', String(r.open));
        name.setAttribute('aria-label', rowLabel(r));
        const count = el('span', 'hoard-tree-count', String(r.count));
        count.setAttribute('aria-hidden', 'true');
        name.append(count);
      } else if (r.key === shownId) name.setAttribute('aria-current', 'page');
      li.append(name);
      stack[stack.length - 1]!.append(li);
      items.push(li);
      if (r.kind === 'folder' && r.open) {
        const sub = el('ul', 'hoard-tree-sub');
        sub.style.setProperty('--depth', String(r.depth));
        li.append(sub);
        stack.push(sub);
      }
    }
    empty.hidden = !listedOnce || entries.length > 0;
    none.hidden = !listedOnce || !entries.length || rows.length > 0;
    none.textContent = none.hidden ? '' : t('No page title holds “{words}”. Clear the filter to see every page.', { words: query.trim() });
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
      if (filtering()) filterOpen = allFolders(matched());
      listedOnce = true;
      stale = false;
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
      dispatch({ type: 'listed' });
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
  const reads = sharedReads(read);
  /** The list read again; a second call while one reads waits for that one. */
  const refresh = (): Promise<void> => reads.shared();

  // ---- the row editor -------------------------------------------------------------------
  const origin = (ask: Ask) => (ask.op === 'new' ? newButton : rowButton(ask.id));

  const settle = async (ask: Ask, verdict: { tree: Tree; path: string }) => {
    const release = ask.op === 'new' ? null : await host.hold();
    try {
      await settleHeld(ask, verdict);
    } finally {
      release?.();
    }
  };

  const settleHeld = async (ask: Ask, verdict: { tree: Tree; path: string }) => {
    const to = `${verdict.tree}/${verdict.path}`;
    // told once the list is read again, which clears the lines
    let said = '';
    let left = '';
    let renamed: { from: string; to: string } | null = null;
    const moves = host.moves();
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
      await reads.fresh();
      const told = explain(ask, entries, err);
      console.warn('hoard: pages tree: refused', { op: ask.op, code: told.code, message: told.message });
      dispatch({ type: 'refused', message: told.message });
      // the folder of a new page may have gone while the store worked
      dispatch({ type: 'listed' });
      return;
    }
    editor = step(editor, { type: 'done' }, entries).editor;
    reveal(to);
    active = to;
    // a read that started before the change would miss it
    await reads.fresh();
    host.changed();
    // after the list, so the page read again resolves its links by the new title
    if (renamed) await host.renamed(renamed.from, renamed.to);
    status.textContent = said;
    alert.textContent = left;
    // asked only now: the writer may have gone back to the book while the list was read
    if (focusInPane()) focusRow(to);
    if (ask.op === 'new' && host.moves() === moves) await host.open(to);
  };

  /** One event through the table; the focus moves only when it is in the tab, or when asked to. */
  function dispatch(e: EditorEvent, take = false) {
    const focus = take || focusInPane();
    const was = editor;
    const next = step(editor, e, entries);
    editor = next.editor;
    const opened = e.type === 'start' && was.state === 'closed';
    // the focus leaves the field before the field goes, so it never falls to the page's body
    if (focus && was.state !== 'closed') {
      if (next.effect === 'focus-origin') origin(was.ask)?.focus();
      if (next.effect === 'focus-parent') nearestRow(askKey(was.ask))?.focus();
    }
    const refolded = next.effect === 'folder-gone';
    if (opened || next.effect === 'busy' || refolded) {
      const key = askKey((editor as Exclude<Editor, { state: 'closed' }>).ask);
      reveal(key);
      if ((e.type === 'start' && e.ask.op === 'new') || refolded) openNow().add(key);
      draw();
    } else {
      drawEditor();
    }
    if (next.effect === 'busy') status.textContent = 'Finish or cancel the open field first.';
    if (refolded && was.state !== 'closed' && was.ask.op === 'new' && editor.state === 'open' && editor.ask.op === 'new') {
      status.textContent = `The folder ${place(was.ask.tree, was.ask.folder)} is no longer there. It may have been moved or removed outside NEO. The new page will go in ${place(editor.ask.tree, editor.ask.folder)}.`;
      console.info('hoard: pages tree: folder gone', { from: place(was.ask.tree, was.ask.folder), to: place(editor.ask.tree, editor.ask.folder) });
    }
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

  const startOn = (op: 'rename' | 'move', key: string, take = false) => {
    const entry = entries.find((x) => x.id === key);
    if (!entry) return;
    setActive(key);
    dispatch({ type: 'start', ask: { op, id: key, value: op === 'rename' ? entry.title : folderOf(entry.path) } }, take);
  };

  // A row's menu, at the pointer or hung from the row. NEO's menu closes an unpinned left pane
  // as it goes, so the tab is shown again for what was chosen.
  const rowMenu = async (b: HTMLButtonElement, x: number, y: number) => {
    const r = rows.find((row) => row.key === b.dataset['key']);
    if (!r) return;
    setActive(r.key);
    const choice = await popMenu(x, y, r.kind === 'page'
      ? [{ label: t('Open'), value: 'open' }, { label: t('Rename page…'), value: 'rename' }, { label: t('Move page…'), value: 'move' }]
      : [{ label: t('New page here'), value: 'new' }], { from: b });
    if (choice === null && !element.contains(document.activeElement)) return;
    host.show();
    if (choice === 'open') {
      focusRow(r.key);
      await host.open(r.key);
    } else if (choice === 'rename' || choice === 'move') startOn(choice, r.key, true);
    else if (choice === 'new') dispatch({ type: 'start', ask: { op: 'new', tree: r.tree, folder: r.path, value: '' } }, true);
  };

  // The tab asked for by the writer: shown, with its list read if it is out of date, and the
  // filter cleared if it hides the row wanted.
  const ready = async (key: string | null) => {
    host.show();
    if (stale) await refresh();
    if (key && filtering() && !filterPages(entries, query).some((e) => e.id === key || e.id.startsWith(`${key}/`))) {
      filter.value = '';
      query = '';
    }
  };

  // the folder of the row the writer is on, else the top of wiki
  const folderHere = (): { tree: Tree; folder: string } => {
    const r = rows.find((x) => x.key === active);
    if (!r) return { tree: 'wiki', folder: '' };
    return { tree: r.tree, folder: r.kind === 'folder' ? r.path : folderOf(r.path) };
  };

  // ---- events ---------------------------------------------------------------------------
  filter.addEventListener('input', () => {
    query = filter.value;
    filterOpen = allFolders(matched());
    draw();
  });
  // down from the filter to the first row, as from a search box to its results
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' || !rows[0]) return;
    e.preventDefault();
    focusRow(rows[0].key);
  });
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
    const r = rows.find((x) => x.key === key);
    if (!r) return;
    setActive(key);
    if (r.kind === 'folder') {
      if (r.open) openNow().delete(key);
      else openNow().add(key);
      draw();
    } else {
      host.open(key).catch((err: unknown) => console.warn('hoard: pages tree: the page did not open', err));
    }
  });
  list.addEventListener('contextmenu', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('.hoard-tree-name');
    if (!b || form.contains(b)) return;
    e.preventDefault();
    rowMenu(b, e.clientX, e.clientY).catch((err: unknown) => console.warn('hoard: pages tree: a row menu failed', err));
  });
  list.addEventListener('keydown', (e) => {
    const b = e.target as HTMLButtonElement;
    if (!b.classList.contains('hoard-tree-name')) return;
    if ((e.key === 'F10' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      rowMenu(b, 0, 0).catch((err: unknown) => console.warn('hoard: pages tree: a row menu failed', err));
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
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
        if (r.kind === 'folder' && !r.open) { openNow().add(r.key); draw(); } else if (r.kind === 'folder') go(rows[at + 1]?.parent === r.key ? rows[at + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (r.kind === 'folder' && r.open) { openNow().delete(r.key); draw(); } else if (r.parent) go(rows.find((x) => x.key === r.parent));
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
    // Taking the form out of the page blurs the field from inside that change, and a
    // dispatch then would draw into it. Judged once it is done, and not at all if the
    // field has the focus back by then (the form moved to another row).
    queueMicrotask(() => { if (document.activeElement !== input) dispatch({ type: 'blur' }); });
  });
  // NEO takes Esc in the left pane on the document's way down and goes back to the page, so
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

  // the list is read when the tab shows and is out of date: first after each book opens
  const shown = () => !host.paneRoot.hidden;
  new MutationObserver(() => { if (shown() && stale) refresh().catch(() => {}); }).observe(host.paneRoot, { attributes: true, attributeFilter: ['hidden'] });
  neo.on('book-open', () => {
    stale = true;
    if (shown()) refresh().catch(() => {});
  });
  draw();

  return {
    element,
    refresh,
    /** The stored page the column shows, marked on its row, its folders opened so the row is there when Pages shows. */
    markShown(id: string | null) {
      shownId = id;
      if (id) reveal(id);
      draw();
      if (id && shown()) rowButton(id)?.scrollIntoView({ block: 'nearest' });
    },
    /** The tab shown with the focus on a row: a folder's opened, a page's, else the first. */
    async reveal(key: string | null) {
      await ready(key);
      if (key) {
        reveal(key);
        if (!key.endsWith('.html')) openNow().add(key);
      }
      draw();
      const target = (key && rowButton(key)) || (shownId && rowButton(shownId)) || list.querySelector<HTMLButtonElement>('.hoard-tree-name');
      if (target) focusRow(target.dataset['key']!);
    },
    /** Rename or Move asked for from the column: the tab shown, the field under the page's row, the focus in it. */
    async edit(op: 'rename' | 'move', id: string) {
      await ready(id);
      startOn(op, id, true);
    },
    /** For tests and the console. */
    state: () => structuredClone({ query, open: [...open], active, editor, pages: entries.length }),
  };
}
