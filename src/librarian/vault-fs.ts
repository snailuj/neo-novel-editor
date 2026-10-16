// The vault on disk, read the way hoard's vault.py reads it, for the command line. Every
// check is pure over what this returns; nothing else under src/librarian/ touches a file.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { type Layout } from './scheme.ts';
import { type Note, byPathParts, includeAttachment, includeNote } from './vault.ts';

// Python's 'utf-8' codec: a malformed byte is an error, and a byte-order mark is kept.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Bytes as Python's read_text() returns them: UTF-8, through universal newlines. */
export function decodeText(bytes: Uint8Array): string {
  return UTF8.decode(bytes).replace(/\r\n?/g, '\n');
}

export function readText(file: string): string {
  return decodeText(readFileSync(file));
}

// Every file below root, as posix relpaths. Like rglob, a symlink to a folder is not
// followed and is not a file; a symlink to a file is one.
function walk(root: string, rel = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(root, child));
    else if (entry.isFile()) found.push(child);
    else if (entry.isSymbolicLink() && isFile(path.join(root, child))) found.push(child);
  }
  return found;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    // A dangling symlink is no file, as Path.is_dir() and read_text() see it.
    return false;
  }
}

/** The notes (relpath and text) and attachment relpaths of a vault, in the walk's order. */
export function readVault(root: string, layout: Layout): { notes: Note[]; attachments: string[] } {
  const files = walk(root).sort(byPathParts);
  return {
    notes: files.filter((rel) => includeNote(rel, layout)).map((rel) => [rel, readText(path.join(root, rel))] as const),
    attachments: files.filter((rel) => includeAttachment(rel, layout)),
  };
}
