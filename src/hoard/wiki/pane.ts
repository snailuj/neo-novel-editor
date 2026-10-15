// The wiki pane: a section of the right-hand pane, beside the book being written, where
// a page the writer looks up is shown without leaving their place. Following a link in
// the manuscript shows its page here and leaves the caret where it was; links on the
// page shown move the pane to their page; Back and Forward (Alt+Left and Alt+Right in
// the pane) walk the trail. Edit in Wiki Book opens the wiki book at the page, which is
// where pages are edited until the pane can edit them (roadmap: live preview, suggest,
// accept, comment and resolve in the pane).
//
// The pane reads a page through the main half, from its chapter file, so it shows the
// page as last saved. It never takes the focus from the manuscript: only a click or a
// key inside the pane moves the focus, and then it stays in the pane.
import { PageHistory } from './history.ts';
import { linksIn } from './links.ts';

interface PageRead { bookId: string; chId: string; title: string; html: string }
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

// The text of each paragraph of a page's HTML, read inertly: nothing in it runs or loads.
function paragraphsOf(html: string): string[] {
  const inert = document.createElement('template');
  inert.innerHTML = html;
  return [...inert.content.querySelectorAll('p')].map((p) => p.textContent ?? '');
}

export function startWikiPane(neo: NeoApiV4, o: { resolve: () => Resolver; editInBook: (chId: string) => Promise<void> }) {
  const pane = neo.addPane({ id: 'wiki', title: 'Wiki', side: true });
  const history = new PageHistory();
  let shown: PageRead | null = null;
  let asked = 0;

  const root = pane.element;
  root.classList.add('hoard-wiki-pane');
  const nav = el('div', 'hoard-wiki-nav');
  const backButton = button('hoard-wiki-back', '‹ Back');
  const forwardButton = button('hoard-wiki-forward', 'Forward ›');
  const editButton = button('hoard-wiki-edit', 'Edit in Wiki Book');
  nav.append(backButton, forwardButton, editButton);
  const title = el('h3', 'hoard-wiki-title');
  title.tabIndex = -1;
  const status = el('p', 'hoard-status');
  status.setAttribute('role', 'status');
  const body = el('div', 'hoard-wiki-page');
  const empty = el('p', 'hoard-wiki-empty', 'Ctrl+click a [[link]] in your writing, or put the caret in one and choose Plugins > Follow Link, to look its page up here.');
  root.append(nav, title, status, body, empty);

  const refreshNav = () => {
    backButton.disabled = !history.canBack;
    forwardButton.disabled = !history.canForward;
    editButton.disabled = !shown;
    nav.hidden = !shown && !history.current;
    empty.hidden = !!history.current;
  };

  const render = (page: PageRead) => {
    const pages = o.resolve();
    title.textContent = page.title;
    body.replaceChildren(...paragraphsOf(page.html).map((text) => {
      const line = el('p', 'hoard-wiki-line');
      let at = 0;
      for (const link of linksIn([text])) {
        line.append(text.slice(at, link.off));
        const words = text.slice(link.off, link.off + link.len);
        const chId = pages.get(link.target);
        if (chId) {
          const go = button('hoard-wiki-link', words);
          go.addEventListener('click', () => { open(chId); });
          line.append(go);
        } else {
          const gone = el('span', 'hoard-wiki-missing', words);
          gone.title = `No wiki page is called “${link.target}”.`;
          line.append(gone);
        }
        at = link.off + link.len;
      }
      line.append(text.slice(at));
      return line;
    }));
  };

  // Shows the trail's current page, once it has read; a later request wins.
  const showCurrent = async () => {
    const chId = history.current;
    // before a button the writer pressed is disabled, which would drop the focus
    const hadFocus = root.contains(document.activeElement);
    refreshNav();
    if (hadFocus && !root.contains(document.activeElement)) title.focus();
    if (!chId) return;
    const mine = ++asked;
    let page: PageRead | null;
    try {
      page = (await neo.invoke('wiki.page', { chId })) as PageRead | null;
    } catch (err) {
      if (mine !== asked) return;
      status.textContent = `The page could not be read: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (mine !== asked) return;
    shown = page;
    if (!page) {
      title.textContent = '';
      body.replaceChildren();
      status.textContent = 'That page is no longer in the wiki.';
    } else {
      status.textContent = '';
      render(page);
    }
    refreshNav();
    if (hadFocus) title.focus();
  };

  const open = (chId: string) => {
    history.visit(chId);
    pane.show();
    return showCurrent();
  };
  const back = () => (history.back() ? showCurrent() : Promise.resolve());
  const forward = () => (history.forward() ? showCurrent() : Promise.resolve());

  backButton.addEventListener('click', () => { back(); });
  forwardButton.addEventListener('click', () => { forward(); });
  editButton.addEventListener('click', () => { if (shown) o.editInBook(shown.chId); });
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
    shown: () => (shown ? { chId: shown.chId, title: shown.title } : null),
    /** The page shown again, as saved now (after an import, say). */
    reload: () => showCurrent(),
  };
}
