// TEMPORARY. Stage 3 of the pages-as-files build moves ownership and marks to page ids
// (review/owner.ts ownerOf(root, page), marks/store.ts add({page, ...}, who) and
// list(page), with marks at .neo/marks/<page id>.json). Until it merges, this file gives
// ripple the same names and the same storage path. When stage 3 lands, delete this file
// and import those two from their own modules in ripple/main.ts; nothing else changes.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardMarksV1, Mark } from '../../generated/hoard-marks-v1.js';
import { validateHoardMarksV1 } from '../../generated/validators.cjs';
import { writeWhole } from '../files.ts';
import { newMark } from '../marks/model.ts';
import { ownerOf as ownerByFrontmatter } from '../review/owner.ts';
import { readSidecar } from './library.ts';
import type { OwnerOf, RippleMarks } from './ports.ts';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

/** Sources are the author's; a wiki page is as review/owner.ts reads its sidecar; no sidecar, the author's. */
export function shimOwnerOf(log: Log): OwnerOf {
  return async (root, page) => {
    if (page.startsWith('sources/')) return 'author';
    const sidecar = readSidecar(root, page, log);
    return sidecar ? ownerByFrontmatter(sidecar.frontmatter) : 'author';
  };
}

export interface ShimMarksOptions {
  library: () => string;
  /** The library's last commit, or null. */
  head: () => Promise<string | null>;
  /** Told after every write, so the library's history takes the file. */
  wrote: (name: string) => void;
  now?: () => Date;
  log: Log;
}

const fileOf = (library: string, page: string) => path.join(library, '.neo', 'marks', ...page.split('/').slice(0, -1), `${page.slice(page.lastIndexOf('/') + 1)}.json`);

function read(file: string): HoardMarksV1 {
  if (!existsSync(file)) return { version: 1, marks: [] };
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!validateHoardMarksV1(data)) throw new TypeError(`${file} cannot be read as marks (${JSON.stringify(validateHoardMarksV1.errors)}); it is left as it is until it is mended`);
  return data;
}

/** Librarian marks on pages. Ripple's calls are serial, and each read-change-write has no wait in it. */
export function shimMarks(o: ShimMarksOptions): RippleMarks {
  return {
    async list(page) {
      return read(fileOf(o.library(), page)).marks;
    },
    async add(req, who) {
      const file = fileOf(o.library(), req.page);
      const commit = await o.head();
      const data = read(file);
      const at = (o.now?.() ?? new Date()).toISOString();
      const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const mark: Mark = newMark({ id, kind: req.kind, anchor: { ...req.anchor, commit }, body: req.body, proposed: req.proposed, who, at });
      const out: HoardMarksV1 = { version: 1, marks: [...data.marks, mark] };
      if (!validateHoardMarksV1(out)) throw new TypeError(`ripple: refusing to write ${file}: ${JSON.stringify(validateHoardMarksV1.errors)}`);
      writeWhole(file, `${JSON.stringify(out, null, 2)}\n`);
      o.log('debug', 'marks.write', { file, marks: out.marks.length, action: 'add', id, kind: req.kind });
      o.wrote('.neo');
      return { id };
    },
  };
}
