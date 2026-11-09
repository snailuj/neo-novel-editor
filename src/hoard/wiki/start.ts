// The wiki's main half: Import to Wiki asks for Markdown files, Import List for an import
// list naming them (import-list.ts), and both say what would come in and import on the
// writer's word; the window asks for the pages to follow links and for one page to show
// in the page column. The questions are OS message boxes, never while the writer types: the
// writer chose the command.
//
// Pages come in as page files (page-import.ts): Import to Wiki fills wiki/, and a list
// sends each page where its line says, to sources/ (the default) or wiki/.
import { BrowserWindow, dialog } from 'electron';
import { readFileSync } from 'node:fs';
import { validateHoardWikiImportV1 } from '../../generated/validators.cjs';
import { checked } from '../checked.ts';
import type { GitLayer } from '../git/layer.ts';
import type { Tree } from '../pages/identity.ts';
import { ListError, readImportList, type ImportList } from './import-list.ts';
import { PageImport, type PageImportOptions, type PageMarks } from './page-import.ts';
import type { Pick, SortedOf } from './picks.ts';
import { describeSort } from './summary.ts';

function parentWindow() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function messageBox(options: Electron.MessageBoxOptions) {
  const parent = parentWindow();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

function openDialog(options: Electron.OpenDialogOptions) {
  const parent = parentWindow();
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// The picks the writer chose, a list's rows left out (with why), or null for a cancel.
async function choose(from: 'pages' | 'list', host: NeoMainHost): Promise<{ picks: DestPick[]; left: ImportList['left'] } | { failed: string } | null> {
  if (from === 'pages') {
    const pick = await openDialog({
      title: 'Import to Wiki', buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'], filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    return pick.canceled || pick.filePaths.length === 0 ? null : { picks: pick.filePaths.map((path) => ({ path, to: 'wiki' as const })), left: [] };
  }
  const pick = await openDialog({
    title: 'Import List', buttonLabel: 'Import',
    properties: ['openFile'], filters: [{ name: 'Import list', extensions: ['txt', 'csv'] }],
  });
  const file = pick.filePaths[0];
  if (pick.canceled || !file) return null;
  try {
    const list = readImportList(file, readFileSync(file, 'utf8'));
    host.log('info', 'wiki.import-list', { file, entries: list.entries.length, left: list.left.length });
    return { picks: list.entries.map(({ path, name, folder, section, sha, to }) => ({ path, name, folder, section, sha, to })), left: list.left };
  } catch (err) {
    const why = err instanceof ListError ? `${file}, ${err.message}.` : `${file} does not read: ${String(err)}`;
    host.log('warn', 'wiki.import-list does not read', why);
    await messageBox({
      type: 'warning', message: 'The import list does not read, so nothing was imported.',
      detail: `${why}\n\nA list names one Markdown page a line, or is a keep/move .csv with path and verdict columns.`,
    });
    return { failed: why };
  }
}

// A pick and the tree of page files it goes to.
type DestPick = Pick & { to: Tree };

/** One tree an import fills. */
interface Target {
  /** In words: sources or the wiki. */
  where: string;
  sort(picks: Pick[]): SortedOf<object>;
  apply(sorted: SortedOf<object>): Promise<Done>;
}

interface Done {
  imported: number;
  updated: number;
  marks: number;
  marksLeft: number;
  keptAsText: number;
  attachments: number;
  missing: string[];
}

function treeTarget(into: PageImport, wrote: () => Promise<unknown>): Target {
  return {
    where: into.tree === 'wiki' ? 'the wiki' : 'sources',
    sort: (picks) => into.sort(picks),
    apply: async (sorted) => {
      const a = await into.apply(sorted as ReturnType<PageImport['sort']>);
      await wrote();
      return { imported: a.imported.length, updated: a.updated.length, marks: a.marks, marksLeft: a.marksLeft, keptAsText: a.keptAsText, attachments: a.attachments, missing: a.missing };
    },
  };
}

// Where a list's picks go, in that order: sources, then the wiki.
function byDest(picks: DestPick[], targets: Targets): { target: Target; picks: Pick[] }[] {
  const groups = new Map<Tree, { target: Target; picks: Pick[] }>();
  for (const { to, ...pick } of picks) {
    let group = groups.get(to);
    if (!group) groups.set(to, group = { target: targets[to], picks: [] });
    group.picks.push(pick);
  }
  return [...groups.entries()].sort(([a], [b]) => Number(b === 'sources') - Number(a === 'sources')).map(([, g]) => g);
}

const joined = (words: string[]) => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

async function runImport(host: NeoMainHost, targets: Targets, from: 'pages' | 'list') {
  const chosen = await choose(from, host);
  if (chosen === null) return { outcome: 'cancelled' };
  if ('failed' in chosen) return { outcome: 'failed', message: chosen.failed };
  const groups = byDest(chosen.picks, targets).map((g) => {
    const sorted = g.target.sort(g.picks);
    return { target: g.target, sorted, summary: describeSort(sorted, g.target.where) };
  });
  const count = groups.reduce((n, g) => n + g.summary.count, 0);
  const many = groups.length > 1;
  const left = chosen.left.length
    ? `\n\nLeft out by the list: ${chosen.left.slice(0, 12).map((l) => `${l.path} (${l.why})`).join(', ')}${chosen.left.length > 12 ? ` and ${chosen.left.length - 12} more` : ''}.`
    : '';
  const detail = groups.map((g) => (many ? `Into ${g.target.where}:\n\n${g.summary.detail}` : g.summary.detail)).join('\n\n') + left;
  const message = many
    ? (count ? `Import ${count} page${count === 1 ? '' : 's'} into ${joined(groups.filter((g) => g.summary.count).map((g) => g.target.where))}?` : 'Every page picked is already where it goes, or cannot come in.')
    : groups[0]!.summary.message;
  if (count === 0) {
    await messageBox({ type: 'info', message, detail });
    return { outcome: 'nothing' };
  }
  const asked = await messageBox({
    type: 'question', message, detail,
    buttons: [`Import ${count} Page${count === 1 ? '' : 's'}`, 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (asked.response !== 0) return { outcome: 'cancelled' };
  // Tree by tree; a tree that stops keeps what was written, and the trees after it wait.
  const done: { target: Target; applied: Done }[] = [];
  for (const g of groups.filter((x) => x.summary.count)) {
    try {
      done.push({ target: g.target, applied: await g.target.apply(g.sorted) });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      host.log('error', 'wiki.import failed', why);
      const landed = done.length ? ` ${joined(done.map((d) => d.target.where))} took ${plural(done.length, 'its', 'their')} pages before it stopped.` : '';
      await messageBox({ type: 'warning', message: 'The import stopped.', detail: `${why}${landed}\n\nWhat was written stays, and importing the same files again finishes it.` });
      return { outcome: 'failed', message: why };
    }
  }
  const sum = (f: (a: Done) => number) => done.reduce((n, d) => n + f(d.applied), 0);
  const updated = sum((a) => a.updated);
  const marks = sum((a) => a.marks);
  const marksLeft = sum((a) => a.marksLeft);
  const keptAsText = sum((a) => a.keptAsText);
  const attachments = sum((a) => a.attachments);
  const missing = done.flatMap((d) => d.applied.missing);
  const n = sum((a) => a.imported + a.updated);
  const into = joined(done.map((d) => d.target.where));
  const copiedInto = joined(done.filter((d) => d.applied.attachments).map((d) => d.target.where));
  const said = [
    updated ? `${updated} ${plural(updated, 'page was', 'pages were')} updated from a newer source.` : '',
    marks ? `${marks} ${plural(marks, 'mark', 'marks')} came with them.` : '',
    marksLeft ? `${marksLeft} CriticMarkup ${plural(marksLeft, 'mark was', 'marks were')} left out, because page files cannot hold marks yet.` : '',
    keptAsText ? `${keptAsText} CriticMarkup ${plural(keptAsText, 'mark stays', 'marks stay')} in the text as written, because ${plural(keptAsText, 'it', 'they')} cannot be a mark here.` : '',
    attachments ? `${attachments} ${plural(attachments, 'image or PDF was', 'images or PDFs were')} copied into ${copiedInto}.` : '',
    missing.length ? `Not found, so not copied: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}.` : '',
  ].filter(Boolean);
  await messageBox({
    type: 'info', message: `${n} page${n === 1 ? ' is' : 's are'} in ${into}.`, detail: said.join(' '),
    buttons: ['Close'], defaultId: 0, cancelId: 0, noLink: true,
  });
  return { outcome: 'imported' };
}

// The two trees an import fills.
class Targets {
  readonly sources: Target;
  readonly wiki: Target;

  constructor(tree: (tree: Tree) => PageImport, wrote: () => Promise<unknown>) {
    this.sources = treeTarget(tree('sources'), wrote);
    this.wiki = treeTarget(tree('wiki'), wrote);
  }
}

/**
 * `pageMarks` holds the marks of imported pages; `pagesWrote` is told when an import has
 * written page files, so the page store reads its trees again (pages/store.ts);
 * `pageImported` is told of each page file an import wrote (page-import.ts).
 */
export function startWiki(host: NeoMainHost, layer: GitLayer, o: { pageMarks?: PageMarks; pagesWrote?: () => Promise<unknown>; pageImported?: PageImportOptions['imported'] } = {}): void {
  const { pageMarks, pagesWrote = () => Promise.resolve(), pageImported } = o;
  const targets = new Targets((tree) => new PageImport({
    library: () => host.paths.library(),
    tree,
    ...(pageMarks ? { marks: pageMarks } : {}),
    ...(pageImported ? { imported: pageImported } : {}),
    head: () => layer.head(),
    wrote: (name) => layer.wrote(name),
    commit: (part) => layer.commitNow(part === 'author' ? 'import-author' : 'import'),
    log: host.log.bind(host),
  }), pagesWrote);
  host.handle('wiki.import', (payload) => {
    const { from = 'pages' } = checked('wiki.import', validateHoardWikiImportV1, payload);
    return runImport(host, targets, from);
  });
}
