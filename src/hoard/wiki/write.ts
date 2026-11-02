// A wiki page written from the Wiki pane, beside another book. The window works out the
// page's new HTML from what it read (wiki/edit.ts); this swaps the file whole, and only
// while it still holds what the window read, so a change that came from another device
// meanwhile is never written over. The open book's window owns its chapter files, so the
// window never asks while the wiki book is open.
//
// The librarian's change sits between two commits and a gate refusal puts the page back
// (asLibrarian, review/edit.ts, which pages.edit shares). The writer's own change is left
// to the next checkpoint, as their typing is.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitLayer } from '../git/layer.ts';
import { oneName, writeWhole } from '../files.ts';
import { asLibrarian, type Written } from '../review/edit.ts';

export type Who = 'librarian' | 'author';

export interface PageWrite {
  chId: string;
  /** The page's HTML as the window read it. */
  before: string;
  /** The page's HTML with the change. */
  after: string;
  as: Who;
}

export type PageWritten = Written;

export interface PageWriterOptions {
  library(): string;
  /** The wiki book's id and whether it lists the page, or null when there is no wiki. */
  listed(chId: string): { bookId: string } | null;
  layer: Pick<GitLayer, 'around' | 'wrote' | 'release' | 'held'>;
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown): void;
  /** Told the book and chapter ids once the author's edit is written; never for the librarian's. */
  saved?: (bookId: string, chId: string) => void;
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
    o.saved?.(bookId, chId);
    return { ok: true };
  }

  const restore = async (): Promise<void> => {
    const now = await readFile(file, 'utf8').catch(() => null);
    if (now === ask.after) return writeWhole(file, ask.before);
    // The page is no longer what the swap wrote, so the refused text may still be on disk: it stays held.
    const reason = now === null ? 'missing' : 'stale';
    o.log('error', 'wiki.edit: the refused librarian change could not be put back, so the page stays held', { chId, reason });
    throw new Error(`wiki.edit: could not put ${rel} back after the library check refused the change (${reason})`);
  };
  return asLibrarian(o, 'wiki.edit', { chId }, [rel], swap, restore);
}
