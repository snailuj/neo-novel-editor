// The wiki pane: a section of the right-hand pane, beside the book being written, where
// a page the writer looks up is shown without leaving their place. Following a link in
// the manuscript shows its page here and leaves the caret where it was; links on the
// page shown move the pane to their page; Back and Forward (Alt+Left and Alt+Right in
// the pane) walk the trail. Edit in Wiki Book opens the wiki book at the page. The page's
// words can be edited in place (wiki/pane-edit.ts), so before the pane moves to another
// page, shows this one again or opens the wiki book, it waits for what was typed to be
// saved (beforeLeave).
//
// The pane shows two kinds of page while the Wiki book still exists: a Wiki book chapter,
// read by wiki.page, and a stored page (pages as files, an id that starts wiki/ or
// sources/), read by pages.read. A stored page is read-only here until the pane can edit
// one (stage 6), so the pane's edit and marks code is told of no page while one is shown
// (onShown gets null, shown() is null) and Edit in Wiki Book is disabled. Links on a stored
// page reach pages by title, a wiki page before a source (pages/titles.ts), then the Wiki
// book; the trail holds both kinds of id. Above the page, the Pages tree (wiki/pane-tree.ts)
// lists the stored pages to open, make, rename and move; the trail follows a rename.
//
// The pane reads a page through the main half, from its file, so it shows the page as last
// saved, kept to its paragraphs, their wiki classes and NEO's inline formatting
// (pageBlocks). It never takes the focus from the manuscript: only a click or a key inside
// the pane moves the focus, and then it stays in the pane.
import { titleIndex } from '../pages/titles.ts';
import { PageHistory } from './history.ts';
import { linksIn } from './links.ts';
import { startPagesTree } from './pane-tree.ts';
import type { Listed } from './tree.ts';

interface PageRead { bookId: string; chId: string; title: string; html: string }
interface StoredRead { id: string; title: string; html: string }
interface Resolver { get(target: string): string | undefined }

/** A stored page's id, as against a Wiki book chapter's. */
export const isStored = (id: string) => /^(?:wiki|sources)\//.test(id);

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

// What the pane keeps of a page's HTML: the paragraphs with their wiki classes and
// data, and NEO's own inline formatting. Anything else is left out for its text, so a
// page read from disk can never put a script, a style or a live link in the window.
const BLOCK_CLASS = /^(?:wiki-[a-z0-9-]+|scene-break)$/;
const BLOCK_DATA = ['depth', 'n', 'task', 'callout', 'lang', 'head', 'block'];
const INLINE = new Set(['B', 'I', 'U', 'S', 'EM', 'STRONG', 'CODE']);
// the CSS highlight on words a search found on the page shown
const FOUND = 'hoard-wiki-found';

function pageBlocks(html: string): HTMLTemplateElement {
  // read inertly: nothing in it runs or loads
  const inert = document.createElement('template');
  inert.innerHTML = html;
  return inert;
}

export function startWikiPane(neo: NeoApiV5, o: { resolve: () => Resolver; editInBook: (chId: string) => Promise<void> }) {
  const pane = neo.addPane({ id: 'wiki', title: 'Wiki', side: true });
  const history = new PageHistory();
  // the page drawn: a Wiki book chapter, or a stored page, or neither
  let shown: PageRead | null = null;
  let stored: StoredRead | null = null;
  let asked = 0;
  // pages the writer has gone to (opened, Back, Forward, a link followed): a link waits on
  // nothing once the writer goes on from it
  let moves = 0;
  const shownListeners: ((page: PageRead | null) => void)[] = [];
  const leaving: (() => Promise<void>)[] = [];
  const beforeLeaving = async () => { for (const fn of leaving) await fn(); };
  // where to take the reader on the next page drawn: words a search found
  let showAt: { pIdx: number; off: number; len: number } | null = null;

  const root = pane.element;
  root.classList.add('hoard-wiki-pane');
  const nav = el('div', 'hoard-wiki-nav');
  const backButton = button('hoard-wiki-back', '‹ Back');
  const forwardButton = button('hoard-wiki-forward', 'Forward ›');
  const editButton = button('hoard-wiki-edit', 'Edit in Wiki Book');
  nav.append(backButton, forwardButton, editButton);
  const title = el('h3', 'hoard-wiki-title');
  title.tabIndex = -1;
  // where a stored page lives, as a trail of its folders
  const where = el('p', 'hoard-wiki-where');
  const status = el('p', 'hoard-status hoard-wiki-status');
  status.setAttribute('role', 'status');
  const body = el('div', 'hoard-wiki-page');
  const empty = el('p', 'hoard-wiki-empty', 'Ctrl+click a [[link]] in your writing, or put the caret in one and choose Plugins > Follow Link, to look its page up here. Or open Pages above and pick one.');
  const tree = startPagesTree(neo, {
    open: (id) => open(id),
    renamed: async (from, to) => {
      history.rename(from, to);
      if (stored?.id === from) stored = { ...stored, id: to };
      // the page shown may be the one renamed, or hold a link to it
      if (history.current) await showCurrent();
    },
    moves: () => moves,
    paneRoot: root,
  });
  root.append(tree.element, nav, title, where, status, body, empty);

  const refreshNav = () => {
    backButton.disabled = !history.canBack;
    forwardButton.disabled = !history.canForward;
    editButton.disabled = !shown;
    editButton.title = stored ? 'Only a Wiki Book page opens in the Wiki Book.' : '';
    nav.hidden = !shown && !stored && !history.current;
    empty.hidden = !!history.current;
  };

  // Text with its [[links]] as buttons to their pages, or marked missing.
  const linked = (text: string, pages: Resolver): Node[] => {
    const out: Node[] = [];
    let at = 0;
    for (const link of linksIn([text])) {
      out.push(document.createTextNode(text.slice(at, link.off)));
      const words = text.slice(link.off, link.off + link.len);
      if (pages.get(link.target)) {
        const go = button('hoard-wiki-link', words);
        // one piece while the page is edited: its words are changed in the wiki book
        go.contentEditable = 'false';
        go.addEventListener('click', () => {
          follow(link.target).catch((err: unknown) => {
            status.textContent = `The link could not be followed: ${err instanceof Error ? err.message : String(err)}. Try again.`;
          });
        });
        out.push(go);
      } else {
        const gone = el('span', 'hoard-wiki-missing', words);
        gone.title = `No wiki page is called “${link.target}”.`;
        out.push(gone);
      }
      at = link.off + link.len;
    }
    out.push(document.createTextNode(text.slice(at)));
    return out;
  };

  const copyInline = (from: Node, to: Node, pages: Resolver, inCode: boolean) => {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        if (inCode) to.appendChild(document.createTextNode(text));
        else for (const node of linked(text, pages)) to.appendChild(node);
      } else if (child instanceof Element) {
        if (INLINE.has(child.tagName)) {
          const kept = document.createElement(child.tagName.toLowerCase());
          copyInline(child, kept, pages, inCode || child.tagName === 'CODE');
          to.appendChild(kept);
        } else {
          copyInline(child, to, pages, inCode);
        }
      }
    }
  };

  // The words at a place on the page drawn, marked and scrolled to.
  const markAt = (at: { pIdx: number; off: number; len: number }) => {
    const line = body.children[at.pIdx];
    if (!line) return;
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let started = false;
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const n = node.textContent?.length ?? 0;
      if (!started && at.off <= seen + n) {
        range.setStart(node, at.off - seen);
        started = true;
      }
      if (started && at.off + at.len <= seen + n) {
        range.setEnd(node, at.off + at.len - seen);
        if (typeof Highlight === 'function') CSS.highlights.set(FOUND, new Highlight(range));
        break;
      }
      seen += n;
    }
    line.scrollIntoView({ block: 'center' });
  };

  const readList = async () => (await neo.invoke('pages.list')) as Listed[];
  // A stored page's links: a stored page by title, wiki first, then the Wiki book.
  const storedResolver = (library: readonly Listed[]): Resolver => {
    const index = titleIndex(library);
    const book = o.resolve();
    return { get: (target) => index.resolve(target)?.id ?? book.get(target) };
  };

  // A link found when it is followed, from a stored page against the list read again, so a
  // page made, moved or removed outside the tree since the page was drawn is reached or said gone.
  const follow = async (target: string) => {
    const fromStored = !!stored;
    // a page gone to since (Back, another link) stands over this one
    const mine = ++moves;
    const library = fromStored ? await readList() : null;
    if (mine !== moves) return;
    const id = (library ? storedResolver(library) : o.resolve()).get(target);
    if (id) await open(id);
    else status.textContent = `No page is called “${target}” now. It may have been renamed or removed outside NEO.`;
  };

  const render = (page: { title: string; html: string }, pages: Resolver) => {
    title.textContent = page.title;
    CSS.highlights?.delete(FOUND);
    body.replaceChildren(...[...pageBlocks(page.html).content.querySelectorAll('p')].map((source) => {
      const line = el('p', 'hoard-wiki-line');
      for (const name of source.classList) if (BLOCK_CLASS.test(name)) line.classList.add(name);
      for (const key of BLOCK_DATA) {
        const value = source.getAttribute(`data-${key}`);
        if (value !== null) line.setAttribute(`data-${key}`, value);
      }
      copyInline(source, line, pages, line.classList.contains('wiki-code'));
      return line;
    }));
  };

  // Shows the trail's current page, once it has read; a later request wins.
  const showCurrent = async () => {
    const id = history.current;
    const at = showAt;
    showAt = null;
    // before a button the writer pressed is disabled, which would drop the focus
    const hadFocus = root.contains(document.activeElement);
    refreshNav();
    if (hadFocus && !root.contains(document.activeElement)) title.focus();
    if (!id) return;
    const mine = ++asked;
    await beforeLeaving();
    if (mine !== asked) return;
    let page: PageRead | StoredRead | null;
    // read for each stored page drawn, so its links reach the library as it is now; this
    // showing's own list, so one read earlier and answered later never decides them
    let library: Listed[] = [];
    try {
      if (isStored(id)) {
        library = await readList();
        page = (await neo.invoke('pages.read', { id })) as StoredRead | null;
      } else {
        page = (await neo.invoke('wiki.page', { chId: id })) as PageRead | null;
      }
    } catch (err) {
      if (mine !== asked) return;
      status.textContent = `The page could not be read: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (mine !== asked) return;
    const chapter = page && !isStored(id) ? page as PageRead : null;
    shown = chapter;
    stored = page && isStored(id) ? { id, title: page.title, html: page.html } : null;
    where.textContent = stored ? id.split('/').slice(0, -1).join(' / ') : '';
    if (!page) {
      title.textContent = '';
      body.replaceChildren();
      status.textContent = isStored(id)
        ? 'That page is no longer there. It may have been moved or removed outside NEO.'
        : 'That page is no longer in the wiki.';
    } else {
      status.textContent = stored ? 'Read-only: this page can\'t be changed in the pane yet.' : '';
      render(page, stored ? storedResolver(library) : o.resolve());
      if (at) markAt(at);
    }
    for (const fn of shownListeners) fn(chapter);
    tree.markShown(stored?.id ?? null);
    refreshNav();
    // a page opened from the tree leaves the focus on its row
    if (hadFocus && !tree.element.contains(document.activeElement)) title.focus();
  };

  /** A page shown (a Wiki book chapter or a stored page), and with at the words there marked and scrolled to. */
  const open = (id: string, at?: { pIdx: number; off: number; len: number }) => {
    showAt = at ?? null;
    moves++;
    history.visit(id);
    pane.show();
    return showCurrent();
  };
  const went = (to: string | null) => {
    if (!to) return Promise.resolve();
    moves++;
    return showCurrent();
  };
  const back = () => went(history.back());
  const forward = () => went(history.forward());

  backButton.addEventListener('click', () => { back(); });
  forwardButton.addEventListener('click', () => { forward(); });
  editButton.addEventListener('click', async () => {
    if (!shown) return;
    const { chId } = shown;
    await beforeLeaving();
    await o.editInBook(chId);
  });
  root.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    if (e.key === 'ArrowLeft') back();
    else forward();
  });
  refreshNav();

  return {
    open,
    back,
    forward,
    /** The Wiki book chapter shown; null while a stored page or nothing is. */
    shown: () => (shown ? { chId: shown.chId, title: shown.title } : null),
    /** The stored page shown (wiki/... or sources/...); null while a chapter or nothing is. */
    currentPage: () => stored?.id ?? null,
    /** The Pages tree, for tests and the console. */
    tree: { refresh: () => tree.refresh(), state: () => tree.state() },
    /** The page shown again, as saved now (after an import, say). */
    reload: () => showCurrent(),
    /** The pane's section, and the element holding the page's lines, one per paragraph in order. */
    root,
    body,
    /** Told after each page is drawn in the pane, with null when it is gone. */
    onShown(fn: (page: PageRead | null) => void) { shownListeners.push(fn); },
    /** Waited for before the pane shows a page (this one again too) or opens the wiki book. */
    beforeLeave(fn: () => Promise<void>) { leaving.push(fn); },
    /** A wider right-hand pane while on (host API 5). */
    wide: (on: boolean) => pane.wide(on),
  };
}
