// A wiki page's attachments: the images and PDFs a Markdown page embeds or links. Each
// one is copied byte for byte into the wiki book's attachments folder, so nothing the
// page shows is left behind in the old vault. NEO draws no image in a chapter, so the
// page keeps its embed as written until the wiki pane draws attachments.
//
// An attachment is found as Obsidian finds it: the path from the vault's root, then
// from the page's folder, then by its name anywhere in the vault outside dot-folders.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isFence, maskCodeSpans } from '../../librarian/links.ts';
import { oneName, writeWhole } from '../files.ts';

const KINDS = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|pdf)$/i;
const WIKI = /(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const MARKDOWN = /!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g;

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function decoded(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/** The attachments a page names, each once, in the order first named. Pure. */
export function attachmentsIn(markdown: string): string[] {
  const found = new Set<string>();
  let inFence = false;
  for (const raw of markdown.split(/\r\n?|\n/)) {
    if (isFence(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = maskCodeSpans(raw);
    const hits: [number, string][] = [];
    for (const m of line.matchAll(WIKI)) hits.push([m.index, m[2]!.trim()]);
    for (const m of line.matchAll(MARKDOWN)) {
      const target = m[1] ?? m[2]!;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) hits.push([m.index, decoded(target).trim()]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    for (const [, target] of hits) if (KINDS.test(target)) found.add(target.replace(/\\/g, '/'));
  }
  return [...found];
}

/** Finds a page's attachments inside one vault; the vault is walked once, when first needed. */
export class AttachmentFinder {
  readonly #root: string;
  #byName: Map<string, string> | null = null;

  constructor(vaultRoot: string) {
    this.#root = path.resolve(vaultRoot);
  }

  #inside(file: string): boolean {
    const rel = path.relative(this.#root, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  #isFile(file: string): boolean {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  }

  // Every attachment in the vault by lower-case name; the first in walk order wins, as a
  // name Obsidian finds twice is a coin toss there too.
  #names(): Map<string, string> {
    if (this.#byName) return this.#byName;
    const byName = new Map<string, string>();
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && KINDS.test(e.name) && !byName.has(e.name.toLowerCase())) byName.set(e.name.toLowerCase(), full);
      }
    };
    walk(this.#root);
    this.#byName = byName;
    return byName;
  }

  /** The file a page's target names, or null when the vault has none. */
  find(target: string, page: string): string | null {
    for (const base of [this.#root, path.dirname(path.resolve(page))]) {
      const file = path.resolve(base, target);
      if (this.#inside(file) && !path.relative(this.#root, file).split(path.sep).some((part) => part.startsWith('.')) && this.#isFile(file)) return file;
    }
    return this.#names().get(path.basename(target).toLowerCase()) ?? null;
  }
}

/**
 * Copies one attachment into the wiki book's attachments folder, byte for byte. A copy
 * with the same bytes already there is used again; a different file under a name
 * already taken gets a numbered name. `dest` is relative to the library.
 */
export function copyAttachment(library: string, bookId: string, file: string): { dest: string; sha256: string; copied: boolean } {
  const dir = path.join(library, oneName(bookId, 'bookId'), 'attachments');
  const bytes = readFileSync(file);
  const sha = sha256(bytes);
  const { name: stem, ext } = path.parse(oneName(path.basename(file), 'attachment'));
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`;
    const dest = path.join(dir, name);
    const rel = `${bookId}/attachments/${name}`;
    if (!existsSync(dest)) {
      writeWhole(dest, bytes);
      return { dest: rel, sha256: sha, copied: true };
    }
    if (sha256(readFileSync(dest)) === sha) return { dest: rel, sha256: sha, copied: false };
  }
}
