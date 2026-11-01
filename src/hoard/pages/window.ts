// The window's half of a rename. The main half never writes a chapter of the book open in
// the window, because the window's autosave would write over it; it hands back the link
// edits instead, and they are made here through the host's `replace`, which edits the page
// as typing does: the writer's undo can take each back and NEO saves them as it saves
// typing. Nothing here runs unless a caller asks; no menu or pane calls it yet.
import type { ChapterEdits, Renamed } from './store.ts';

/** The part of the plugin host a rename needs (NeoApiV2's replace and book, NeoApi's invoke). */
export interface PagesWindow {
  replace(place: NeoPlace, expectedText: string, newText: string): Promise<NeoReplaceResult>;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  book(): { id: string } | null;
}

export interface Applied {
  applied: number;
  refused: { chId: string; pIdx: number; reason: string }[];
}

/**
 * Makes each edit with `replace`. Edits in one paragraph go last offset first, so the
 * ones before it keep their offsets. A refused edit (the text changed since the file was
 * read, the writer is composing a word) is listed, and the rest still go.
 */
export async function applyChapterEdits(neo: Pick<PagesWindow, 'replace'>, chapters: readonly ChapterEdits[]): Promise<Applied> {
  const done: Applied = { applied: 0, refused: [] };
  for (const { chId, edits } of chapters) {
    for (const e of [...edits].sort((a, b) => b.pIdx - a.pIdx || b.off - a.off)) {
      const result = await neo.replace({ chId, pIdx: e.pIdx, off: e.off, len: e.len }, e.expected, e.replacement);
      if (result.ok) done.applied++;
      else done.refused.push({ chId, pIdx: e.pIdx, reason: result.reason });
    }
  }
  return done;
}

/** Renames a page through the main half, then makes the edits it hands back for the open book. */
export async function renamePage(neo: PagesWindow, id: string, newPath: string): Promise<Renamed & Applied> {
  const renamed = (await neo.invoke('pages.rename', { id, newPath, openBookId: neo.book()?.id ?? null })) as Renamed;
  return { ...renamed, ...(await applyChapterEdits(neo, renamed.deferred)) };
}
