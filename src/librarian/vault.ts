// Which files of a vault are notes, which are attachments, and whose zone each is in.
// The rules of hoard's vault.py, over relative paths, so the reader on disk (vault-fs.ts)
// and a test apply the same ones.
import { type Layout, startsWithAny } from './scheme.ts';

export type Zone = 'librarian' | 'as-is' | 'infra';

/** A note as the checks receive it: its posix path relative to the vault, and its text. */
export type Note = readonly [relpath: string, text: string];

export function zoneOf(relpath: string, layout: Layout): Zone {
  if (startsWithAny(relpath, layout.librarianDirs)) return 'librarian';
  if (startsWithAny(relpath, layout.asIsDirs)) return 'as-is';
  return 'infra';
}

// A dot-directory is tooling, not vault: .git, .venv and the like carry READMEs and
// licences that would otherwise contest link keys with the vault's own notes.
function inDotDirectory(relpath: string): boolean {
  return relpath.split('/').slice(0, -1).some((part) => part.startsWith('.'));
}

/** Whether a file is a note the checks read: Markdown, outside dot-directories and skip dirs. */
export function includeNote(relpath: string, layout: Layout): boolean {
  return relpath.endsWith('.md') && !inDotDirectory(relpath) && !startsWithAny(relpath, layout.skipDirs);
}

/**
 * Whether a file is an attachment: a non-Markdown file in the librarian zones. Obsidian
 * resolves `[[Outline.canvas]]` by its full name, so these are link keys too; nothing
 * reads their bytes.
 */
export function includeAttachment(relpath: string, layout: Layout): boolean {
  const name = relpath.slice(relpath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const suffix = dot > 0 ? name.slice(dot) : '';
  return suffix !== '.md' && !name.startsWith('.') && !inDotDirectory(relpath)
    && startsWithAny(relpath, layout.librarianDirs) && !startsWithAny(relpath, layout.skipDirs);
}
