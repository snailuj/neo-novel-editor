// A wiki page written from the Wiki pane, beside another book. The window works out the
// page's new HTML from what it read (wiki/edit.ts); this swaps the file whole, and only
// while it still holds what the window read, so a change that came from another device
// meanwhile is never written over. The open book's window owns its chapter files, so the
// window never asks while the wiki book is open.
//
// The librarian's change sits between two commits (GitLayer.around): what the writer had
// pending is committed as theirs, then the page as the librarian's. When the pre-commit
// gate refuses that commit, the page is put back as it was, so the change is in neither
// the history nor the file. The writer's own change is left to the next checkpoint, as
// their typing is.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GateRefused, type Finding } from '../git/gate.ts';
import type { GitLayer } from '../git/layer.ts';
import { oneName, writeWhole } from '../files.ts';

export type Who = 'librarian' | 'author';

export interface PageWrite {
  chId: string;
  /** The page's HTML as the window read it. */
  before: string;
  /** The page's HTML with the change. */
  after: string;
  as: Who;
}

export type PageWritten =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'stale' }
  | { ok: false; reason: 'refused'; findings: Finding[] };

export interface PageWriterOptions {
  library(): string;
  /** The wiki book's id and whether it lists the page, or null when there is no wiki. */
  listed(chId: string): { bookId: string } | null;
  layer: Pick<GitLayer, 'around' | 'wrote'>;
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown): void;
}

export async function writePage(o: PageWriterOptions, ask: PageWrite): Promise<PageWritten> {
  const chId = oneName(ask.chId, 'chId');
  const wiki = o.listed(chId);
  if (!wiki) return { ok: false, reason: 'missing' };
  const bookId = oneName(wiki.bookId, 'bookId');
  const rel = `${bookId}/chapters/${chId}.html`;
  const file = path.join(o.library(), rel);
  const swap = async (): Promise<'missing' | 'stale' | null> => {
    const now = await readFile(file, 'utf8').catch(() => null);
    if (now === null) return 'missing';
    if (now !== ask.before) return 'stale';
    writeWhole(file, ask.after);
    return null;
  };

  if (ask.as === 'author') {
    const refused = await swap();
    if (refused) return { ok: false, reason: refused };
    o.layer.wrote(bookId);
    o.log('info', 'wiki.edit', { chId, as: 'author' });
    return { ok: true };
  }

  try {
    const { result: refused, after } = await o.layer.around([rel], swap);
    if (refused) return { ok: false, reason: refused };
    o.log('info', 'wiki.edit', { chId, as: 'librarian', commit: after });
    return { ok: true };
  } catch (err) {
    if (!(err instanceof GateRefused)) throw err;
    writeWhole(file, ask.before);
    o.log('warn', 'wiki.edit: the library check refused the librarian\'s change, so the page is as it was', { chId, findings: err.findings });
    return { ok: false, reason: 'refused', findings: err.findings };
  }
}
