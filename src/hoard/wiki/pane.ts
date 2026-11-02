// The wiki pane: a section of the right-hand pane, beside the book being written, where a
// stored page (a file in the library's wiki/ or sources/ folder, its id such as
// wiki/People/Ada.html) is shown without the writer leaving their place. Following a
// [[link]] in the manuscript shows its page here and leaves the caret where it was
// (wiki/window.ts); links on the page shown move the pane to their page; Back and Forward
// (Alt+Left and Alt+Right in the pane) walk the trail. A link reaches a page by its title,
// a wiki page before a source (pages/titles.ts), against the list read when the page is
// drawn and read again when the link is followed. Above the page, the Pages tree
// (wiki/pane-tree.ts) lists the stored pages to open, make, rename and move; the trail
// follows a rename.
//
// The pane reads a page through the main half, from its file, so it shows the page as last
// saved, kept to its paragraphs, their wiki classes and NEO's inline formatting
// (pageBlocks). A real link or image on the page is a locked chip in the text, kept as
// written. The page is edited in place (wiki/pane-edit.ts), so before the pane shows
// another page, or this one again, it waits for what was typed to be saved (beforeLeave).
// It never takes the focus from the manuscript: only a click or a key inside the pane moves
// the focus, and then it stays in the pane.
import { titleIndex } from '../pages/titles.ts';
import { PageHistory } from './history.ts';
import { linksIn } from './links.ts';
import { startPagesTree } from './pane-tree.ts';
import type { Listed } from './tree.ts';

interface StoredRead { id: string; title: string; html: string }
/** The page shown, as the pane's editing and marks see it. */
export interface ShownPage { id: string; title: string; html: string }
interface Resolver { get(target: string): string | undefined }

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
export const BLOCK_CLASS = /^(?:wiki-[a-z0-9-]+|scene-break)$/;
export const BLOCK_DATA = ['depth', 'n', 'task', 'callout', 'lang', 'head', 'block', 'alias'];
export const INLINE = new Set(['B', 'I', 'U', 'S', 'EM', 'STRONG', 'CODE']);
// A real link or image, shown as one locked piece of the text: its HTML as the page holds
// it rides on the chip and is written back as it was. Nothing in it loads or is followed.
export const CHIP = 'hoard-wiki-chip';
export const CHIP_SOURCE = 'data-hoard-source';
// the CSS highlight on words a search found on the page shown
const FOUND = 'hoard-wiki-found';

function pageBlocks(html: string): HTMLTemplateElement {
  // read inertly: nothing in it runs or loads
  const inert = document.createElement('template');
  inert.innerHTML = html;
  return inert;
}

export function startWikiPane(neo: NeoApiV5, o: { changed: () => void }) {
  const pane = neo.addPane({ id: 'wiki', title: 'Wiki', side: true });
  const history = new PageHistory();
  // the page drawn, if any
  let stored: StoredRead | null = null;
  let asked = 0;
  // pages the writer has gone to (opened, Back, Forward, a link followed): a link waits on
  // nothing once the writer goes on from it
  let moves = 0;
  // where to take the reader on the next page drawn: words a search found
  let showAt: { pIdx: number; off: number; len: number } | null = null;
  const shownListeners: ((page: ShownPage | null) => void)[] = [];
  const leaving: (() => Promise<void>)[] = [];
  const beforeLeaving = async () => { for (const fn of leaving) await fn(); };

  const root = pane.element;
  root.classList.add('hoard-wiki-pane');
  const nav = el('div', 'hoard-wiki-nav');
  const backButton = button('hoard-wiki-back', '‹ Back');
  const forwardButton = button('hoard-wiki-forward', 'Forward ›');
  nav.append(backButton, forwardButton);
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
    changed: o.changed,
    paneRoot: root,
  });
  root.append(tree.element, nav, title, where, status, body, empty);

  const refreshNav = () => {
    backButton.disabled = !history.canBack;
    forwardButton.disabled = !history.canForward;
    nav.hidden = !stored && !history.current;
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
        // one piece while the page is edited: the link's words are typed around
        go.contentEditable = 'false';
        go.addEventListener('click', () => {
          follow(link.target).then((got) => {
            if (got === 'missing') status.textContent = `No page is called “${link.target}” now. It may have been renamed or removed outside NEO.`;
          }, (err: unknown) => {
            status.textContent = `The link could not be followed: ${err instanceof Error ? err.message : String(err)}. Try again.`;
          });
        });
        out.push(go);
      } else {
        const gone = el('span', 'hoard-wiki-missing', words);
        gone.contentEditable = 'false';
        gone.title = `No page is called “${link.target}”.`;
        out.push(gone);
      }
      at = link.off + link.len;
    }
    out.push(document.createTextNode(text.slice(at)));
    return out;
  };

  // A link keeps its words, so the page's text reads as its file's does; an image has none,
  // and says what it is through its label and the stylesheet.
  const chipOf = (source: Element): HTMLElement => {
    const chip = el('span', CHIP);
    chip.contentEditable = 'false';
    chip.setAttribute(CHIP_SOURCE, source.outerHTML);
    if (source.tagName === 'A') {
      chip.classList.add('hoard-wiki-chip-link');
      chip.textContent = source.textContent;
      chip.title = `Link to ${source.getAttribute('href') ?? 'nowhere'}, kept as written`;
    } else {
      const alt = source.getAttribute('alt') ?? '';
      chip.classList.add('hoard-wiki-chip-image');
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', alt ? `Image: ${alt}` : 'Image');
      chip.dataset.alt = alt;
      chip.title = 'Image, kept as written';
    }
    return chip;
  };

  const copyInline = (from: Node, to: Node, pages: Resolver, inCode: boolean) => {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        if (inCode) to.appendChild(document.createTextNode(text));
        else for (const node of linked(text, pages)) to.appendChild(node);
      } else if (child instanceof Element) {
        if (child.tagName === 'A' || child.tagName === 'IMG') {
          to.appendChild(chipOf(child));
        } else if (INLINE.has(child.tagName)) {
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
  // A page's links: a stored page by title, wiki first.
  const resolverOf = (library: readonly Listed[]): Resolver => {
    const index = titleIndex(library);
    return { get: (target) => index.resolve(target)?.id };
  };

  // A link found when it is followed, against the list read again, so a page made, moved or
  // removed outside the tree since the page was drawn is reached or said gone. Dropped if
  // the writer has gone to another page meanwhile.
  const follow = async (target: string): Promise<'opened' | 'missing' | 'dropped'> => {
    // a page gone to since (Back, another link) stands over this one
    const mine = ++moves;
    let library: Listed[];
    try {
      library = await readList();
    } catch (err) {
      if (mine === moves) throw err;
      console.warn('hoard: wiki pane: the list for a link the writer went on from did not read', err);
      return 'dropped';
    }
    if (mine !== moves) return 'dropped';
    const id = resolverOf(library).get(target);
    if (!id) return 'missing';
    await open(id);
    return 'opened';
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
    let page: StoredRead | null;
    // read for each page drawn, so its links reach the library as it is now; this showing's
    // own list, so one read earlier and answered later never decides them
    let library: Listed[];
    try {
      library = await readList();
      page = (await neo.invoke('pages.read', { id })) as StoredRead | null;
    } catch (err) {
      if (mine !== asked) return;
      status.textContent = `The page could not be read: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (mine !== asked) return;
    stored = page ? { id, title: page.title, html: page.html } : null;
    where.textContent = stored ? id.split('/').slice(0, -1).join(' / ') : '';
    if (!page) {
      title.textContent = '';
      body.replaceChildren();
      status.textContent = 'That page is no longer there. It may have been moved or removed outside NEO.';
    } else {
      status.textContent = '';
      render(page, resolverOf(library));
      if (at) markAt(at);
    }
    for (const fn of shownListeners) fn(stored ? { ...stored } : null);
    tree.markShown(stored?.id ?? null);
    refreshNav();
    // a page opened from the tree leaves the focus on its row, and a writer gone back to the
    // book while the page was read stays there; a link drawn over falls to the body
    const here = document.activeElement;
    const inPane = !here || here === document.body || (root.contains(here) && !tree.element.contains(here));
    if (hadFocus && inPane) title.focus();
  };

  /** A stored page shown, and with at the words there marked and scrolled to. */
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
  root.addEventListener('keydown', (e) => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    if (e.key === 'ArrowLeft') back();
    else forward();
  });
  refreshNav();

  return {
    open,
    /** The page a [[link]] names, by title, opened here: 'missing' when no page has it. */
    follow: (target: string) => follow(target),
    back,
    forward,
    /** The stored page shown (wiki/... or sources/...); null while none is. */
    currentPage: () => stored?.id ?? null,
    /** The Pages tree, for tests and the console. */
    tree: { refresh: () => tree.refresh(), state: () => tree.state() },
    /** The page shown again, as saved now (after an import, say). */
    reload: () => showCurrent(),
    /** The pane's section, and the element holding the page's lines, one per paragraph in order. */
    root,
    body,
    /** The page shown, as last drawn; null while none is. */
    shown: (): ShownPage | null => (stored ? { ...stored } : null),
    /** Told after each page is drawn in the pane, with null when it is gone. */
    onShown(fn: (page: ShownPage | null) => void) { shownListeners.push(fn); },
    /** Waited for before the pane shows a page, this one again too. */
    beforeLeave(fn: () => Promise<void>) { leaving.push(fn); },
    /** A wider right-hand pane while on (host API 5). */
    wide: (on: boolean) => pane.wide(on),
  };
}
