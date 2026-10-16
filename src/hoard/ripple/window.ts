// The Ripple section beside the book: what waits for the judge, and each proposal the
// judge made, for the writer to apply, reject or set aside. Nothing here runs unless the
// writer asks: Plugins > Run Ripple, Plugins > Ripple This Chapter, or a button here.
// The section is drawn when it is shown or after a run, never while the writer types.
// A proposal's buttons stay hidden until its card is hovered or holds the focus.

interface Overview {
  wiki: boolean;
  packets: string;
  jobs: { id: string; title: string; hop: number; state: string; problem: string | null; packet: string; answer: string }[];
  proposals: {
    id: string; kind: 'nothing' | 'claim' | 'topic' | 'mint'; status: string; hop: number; reason: string;
    from: string; target: string; anchor: string | null; text: string | null; line: string | null; quote: string | null; delta: string | null;
  }[];
  applied: number;
  rejected: number;
}

interface Ran { said: { message: string; detail: string } }
interface Decided { said: string; page: { bookId: string; chId: string } | null }

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

const KIND: Record<Overview['proposals'][number]['kind'], string> = {
  claim: 'Change', topic: 'Add a line', mint: 'New page', nothing: 'Leave alone',
};

export function startRipple(neo: NeoApiV4, o: {
  wikiId: () => string | null;
  /** A wiki page shown beside the book, the page list read again first. */
  show: (chId: string) => Promise<void>;
}) {
  const pane = neo.addPane({ id: 'ripple', title: 'Ripple', side: true });
  const root = pane.element;
  root.classList.add('hoard-ripple');
  const head = el('div', 'hoard-ripple-head');
  const runButton = button('hoard-ripple-run', 'Run Ripple');
  const folderButton = button('hoard-ripple-folder', 'Packets Folder');
  head.append(runButton, folderButton);
  const status = el('p', 'hoard-status');
  status.setAttribute('role', 'status');
  const alert = el('p', 'hoard-alert');
  alert.setAttribute('role', 'alert');
  const list = el('div', 'hoard-ripple-list');
  root.append(head, status, alert, list);

  let busy = false;
  const say = (text: string, bad = false) => {
    status.textContent = bad ? '' : text;
    alert.textContent = bad ? text : '';
  };
  const wikiOpen = () => {
    const id = o.wikiId();
    return id !== null && neo.book()?.id === id;
  };

  const card = (p: Overview['proposals'][number]) => {
    const c = el('div', 'sticky hoard-ripple-card');
    c.tabIndex = -1;
    c.dataset['status'] = p.status;
    const where = p.kind === 'mint' ? `${KIND[p.kind]}: ${p.target}` : `${KIND[p.kind]} on ${p.target}`;
    c.append(el('span', 'hoard-who', `${where} · from ${p.from}${p.hop ? ` · hop ${p.hop}` : ''}`));
    if (p.kind === 'claim') {
      const change = el('p', 'hoard-ripple-change');
      change.append(el('del', '', p.anchor ?? ''), ' ', el('ins', '', p.text || '(removed)'));
      c.append(change);
    } else if (p.kind === 'topic') {
      c.append(el('p', 'hoard-ripple-change', p.line ?? ''));
    } else if (p.kind === 'mint') {
      c.append(el('p', 'hoard-ripple-change', p.text ?? ''));
    }
    c.append(el('p', 'hoard-entry', p.reason));
    if (p.quote) c.append(el('blockquote', 'hoard-ripple-quote', p.quote));
    if (p.delta) c.append(el('p', 'hoard-label', p.delta));
    const actions = el('div', 's-actions');
    const apply = button('', 'Apply');
    if (wikiOpen()) {
      apply.disabled = true;
      apply.title = 'The wiki is open. Apply from another book.';
    }
    const reject = button('', 'Reject');
    const later = button('', 'Later');
    if (p.status === 'deferred') later.hidden = true;
    for (const [b, decision] of [[apply, 'apply'], [reject, 'reject'], [later, 'defer']] as const) {
      b.addEventListener('click', () => { decide(p.id, decision).catch((err: unknown) => console.debug('hoard: ripple.decide', err)); });
    }
    actions.append(apply, reject, later);
    c.append(actions);
    return c;
  };

  const draw = async () => {
    let view: Overview;
    try {
      view = await neo.invoke('ripple.overview') as Overview;
    } catch (err) {
      say(`Ripple could not read its log: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }
    list.replaceChildren();
    if (!view.wiki) {
      list.append(el('p', 'hoard-wiki-empty', 'Ripple carries changes through the wiki. Import pages to the wiki first.'));
      return;
    }
    const waiting = view.jobs;
    if (waiting.length) {
      list.append(el('h4', 'hoard-ripple-group', `Waiting for the judge (${waiting.length})`));
      const ul = el('ul', 'hoard-ripple-jobs');
      for (const j of waiting) {
        const li = el('li', '', `${j.title || 'Untitled'}${j.hop ? ` · hop ${j.hop}` : ''}${j.state === 'open' ? ' · no packet yet' : ''}`);
        if (j.problem) li.append(el('span', 'hoard-alert hoard-ripple-problem', j.problem));
        ul.append(li);
      }
      list.append(ul);
    }
    const proposed = view.proposals.filter((p) => p.status === 'proposed');
    const deferred = view.proposals.filter((p) => p.status === 'deferred');
    if (proposed.length) {
      list.append(el('h4', 'hoard-ripple-group', `For you to rule on (${proposed.length})`));
      for (const p of proposed) list.append(card(p));
    }
    if (deferred.length) {
      list.append(el('h4', 'hoard-ripple-group', `Set aside (${deferred.length})`));
      for (const p of deferred) list.append(card(p));
    }
    if (!waiting.length && !proposed.length && !deferred.length) {
      list.append(el('p', 'hoard-wiki-empty', view.applied || view.rejected
        ? `Nothing waits. ${view.applied} applied and ${view.rejected} rejected so far.`
        : 'Nothing waits. Run Ripple after importing or changing wiki pages, or use Ripple This Chapter.'));
    }
  };

  const decide = async (id: string, decision: 'apply' | 'reject' | 'defer') => {
    if (busy) return;
    busy = true;
    try {
      const done = await neo.invoke('ripple.decide', { openBookId: neo.book()?.id ?? null, id, decision }) as Decided;
      say(done.said);
      if (decision === 'apply' && done.page && done.page.bookId === o.wikiId() && !wikiOpen()) await o.show(done.page.chId).catch(() => {});
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      busy = false;
    }
    await draw();
  };

  const run = async () => {
    if (busy) return;
    busy = true;
    const book = neo.book();
    say('Ripple is running…');
    try {
      const ran = await neo.invoke('ripple.run', { openBookId: book?.id ?? null, tell: !book }) as Ran;
      say(`${ran.said.message} ${ran.said.detail}`);
    } catch (err) {
      say(`Ripple stopped: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      busy = false;
    }
    if (book) pane.show();
    await draw();
  };

  const rippleChapter = async () => {
    const book = neo.book();
    const chId = neo.where()?.chId ?? null;
    if (!book || !chId) {
      neo.status('Put the caret in a chapter, then choose Ripple This Chapter.');
      return;
    }
    if (busy) return;
    busy = true;
    pane.show();
    const titles = (book['chapterTitles'] ?? {}) as Record<string, string>;
    const n = book.chapterOrder.indexOf(chId);
    const title = titles[chId] || `${book.title || 'Untitled'}, chapter ${n + 1}`;
    try {
      const asked = await neo.invoke('ripple.ask', { bookId: book.id, chId, title }) as { made: boolean; packet: string | null; wiki: boolean };
      if (!asked.wiki) say('There is no wiki yet. Import pages to the wiki first.', true);
      else if (asked.made) say(`The packet for ${title} is in the packets folder, for the judge: ${asked.packet}`);
      else say(`Ripple has this chapter's words already${asked.packet ? `; its packet is ${asked.packet}` : ''}.`);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), true);
    } finally {
      busy = false;
    }
    await draw();
  };

  runButton.addEventListener('click', () => { run().catch((err: unknown) => console.debug('hoard: ripple.run', err)); });
  folderButton.addEventListener('click', () => {
    neo.invoke('ripple.folder').catch((err: unknown) => say(`The folder did not open: ${err instanceof Error ? err.message : String(err)}`, true));
  });
  neo.addCommand('run-ripple', run);
  neo.addCommand('ripple-chapter', rippleChapter);
  neo.on('book-open', () => draw());

  return { run, rippleChapter, draw, decide };
}
