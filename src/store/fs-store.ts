import fs from 'node:fs';
import path from 'node:path';
import { createICloud, type ICloud } from './icloud.ts';
import { createJsonFiles, type JsonFiles } from './json.ts';
import { libName } from './names.ts';
import {
  StoreError,
  type BookMeta,
  type BookSummary,
  type LibraryRecord,
  type LibraryStore,
  type Log,
  type Translate,
} from './types.ts';

export interface FsStoreOptions {
  /** The library folder. */
  root: string;
  log: Log;
  t?: Translate;
  platform?: string;
  /** Share these with code that still reads library files beside the store. */
  icloud?: ICloud;
  json?: JsonFiles;
}

// The library as a folder of plain files: library.json, one folder per book. Every method
// runs its disk work in one synchronous stretch, so a check and the write that follows it
// cannot be interleaved with another save (the async is the interface's, for stores that
// cannot answer at once).
export function createFsStore(options: FsStoreOptions): LibraryStore & { readonly root: string } {
  const { root, log } = options;
  const t: Translate = options.t ?? ((s) => s);
  const platform = options.platform ?? process.platform;
  const icloud = options.icloud ?? createICloud({ platform });
  const json = options.json ?? createJsonFiles({ log, icloud, platform });
  const { readJSON, writeJSON, writeFileDurable } = json;

  const libraryFile = path.join(root, 'library.json');
  const bookDir = (bookId: string) => path.join(root, libName(bookId));

  // A brand-new library starts with one empty shelf. A library.json that has gone missing
  // beside its spare copies or its books is not a new library: readLibrary recovers it
  // (from .tmp/.bak, else from the book folders) instead of an empty seed hiding every book.
  function libraryHasHistory(): boolean {
    if (fs.existsSync(libraryFile + '.bak') || fs.existsSync(libraryFile + '.tmp')) return true;
    try { return fs.readdirSync(root).some((d) => d.startsWith('book-')); } catch { return false; }
  }

  function ensureLibrary(): void {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(libraryFile) && !libraryHasHistory()) {
      const seed = {
        authorName: '',
        penNames: [],
        firstRunDone: false,
        pageTheme: 'night',
        shelves: [{ id: 'shelf-1', name: t('Works in Progress'), bookIds: [] }],
      };
      fs.writeFileSync(libraryFile, JSON.stringify(seed, null, 2));
    }
  }

  // A human-readable map of the library, regenerated on every change: which folder is
  // which book, and what shelf it lives on. Sorts to the top of the folder so browsing
  // writers can always find their way.
  function writeCatalog(): void {
    try {
      const lib = readJSON(libraryFile, { shelves: [] }) as { shelves?: { name: string; bookIds: string[] }[] };
      const onShelf: Record<string, string> = {};
      for (const s of lib.shelves || []) {
        for (const id of s.bookIds) onShelf[id] = s.name;
      }
      const lines: string[] = [];
      const metas = fs.readdirSync(root).filter((d) => d.startsWith('book-')).map((d) => path.join(root, d, 'book.json'));
      // a book still in iCloud would drop out of the catalog: leave it as it is
      const away = icloud.cloudOnlyAmong(metas);
      if (away.size) { icloud.requestDownload(away); return; }
      for (const d of fs.readdirSync(root)) {
        if (!d.startsWith('book-')) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(root, d, 'book.json'), 'utf8'));
          lines.push(`${m.title || t('Untitled')}  —  ${d}  —  ${t('shelf:')} ${onShelf[m.id] || t('(none — removed from shelves)')}`);
        } catch { /* not a valid book folder */ }
      }
      lines.sort((a, b) => a.localeCompare(b));
      const text = t('NEO LIBRARY CATALOG — which folder is which book') + '\n' +
        t('(regenerated automatically; edits here do nothing)') + '\n\n' +
        lines.join('\n') + '\n';
      const file = path.join(root, '_catalog.txt');
      // the catalog itself still in iCloud: reading it would wait on iCloud (on every
      // save), and it's never written over. It's asked for, and brought up to date on the
      // next save once it's here.
      if (icloud.isCloudOnly(file)) { icloud.requestDownload([file]); return; }
      // unchanged, it's left alone: a rewrite on every save is a file for iCloud and
      // Syncthing to send back and forth (and to clash over)
      let old: string | null = null;
      try { old = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
      if (old !== text) fs.writeFileSync(file, text);
    } catch (err) {
      log('catalog', err);
    }
  }

  // A book whose book.json is gone for good (and no .bak) still has its chapters: the
  // book comes back with them in the order they were made, its title from the catalog,
  // rather than vanishing from the shelf.
  function rebuildBookMeta(bookId: string): BookMeta | null {
    const dir = bookDir(bookId);
    const chDir = path.join(dir, 'chapters');
    if (!fs.existsSync(chDir)) return null;
    let title = '';
    try {
      const catFile = path.join(root, '_catalog.txt');
      const cat = icloud.isCloudOnly(catFile) ? '' : fs.readFileSync(catFile, 'utf8');
      const line = cat.split('\n').find((l) => l.includes('  —  ' + bookId + '  —  '));
      if (line) title = line.split('  —  ')[0].trim();
    } catch { /* no catalog */ }
    const order = fs.readdirSync(chDir).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort();
    const meta: BookMeta = {
      id: bookId,
      title: title || t('Untitled'),
      subtitle: '', series: '', author: t('Anonymous'), wordGoal: 0,
      created: new Date().toISOString(), modified: new Date().toISOString(),
      chapterOrder: order,
      tabNames: { notes: 'Notes', outline: 'Outline' },
    };
    log('recovered', `${bookId}/book.json was lost; rebuilt from ${order.length} chapter files`);
    try { writeJSON(path.join(dir, 'book.json'), meta); } catch (err) { log('recover write', err); }
    return meta;
  }

  function readLibraryFile(): LibraryRecord {
    const lib = readJSON(libraryFile, null) as LibraryRecord | null;
    if (lib) return lib;
    // library.json lost with no copy to fall back on: every book in the folder goes onto
    // one shelf, so nothing disappears
    const ids: string[] = [];
    try {
      for (const d of fs.readdirSync(root)) {
        if (d.startsWith('book-') && fs.existsSync(path.join(root, d, 'chapters'))) ids.push(d);
      }
    } catch { /* empty */ }
    const seed = {
      authorName: '', penNames: [], firstRunDone: ids.length > 0, pageTheme: 'night',
      shelves: [{ id: 'shelf-1', name: t('Works in Progress'), bookIds: ids }],
    };
    log('recovered', `library.json was lost; ${ids.length} books put back on one shelf`);
    try { writeJSON(libraryFile, seed); } catch (err) { log('recover write', err); }
    return seed;
  }

  // the book id folders carry a slug of the title when it's known at creation (imports),
  // so the library reads like a bookshelf in Finder too. Accents come off first, so
  // "Capítulo" reads "capitulo", not "cap-tulo"
  function newBookId(title: unknown): string {
    const slug = String(title || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    return 'book-' + (slug ? slug + '-' : '') + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function listBooksSync(): BookSummary[] {
    const out: BookSummary[] = [];
    try {
      for (const d of fs.readdirSync(root)) {
        if (!d.startsWith('book-')) continue;
        type Meta = { id?: string; title?: string; author?: string; modified?: string; kind?: string };
        let m: Meta | null = null;
        try { m = readJSON(path.join(root, d, 'book.json'), null) as Meta | null; } catch { continue; } // still in iCloud
        // the folder is the book: a copied folder ("book-x copy") is its own book, even
        // though the book.json inside still names the original
        if (m && m.id) out.push({ id: d, title: m.title || t('Untitled'), author: m.author || '', modified: m.modified || '', kind: m.kind || '' });
      }
    } catch (err) { log('listBooks', err); }
    return out;
  }

  function readBookMetaSync(bookId: string): BookMeta | null {
    const dir = bookDir(bookId);
    const meta = readJSON(path.join(dir, 'book.json'), null) as BookMeta | null;
    if (meta) {
      if (meta.id !== bookId) meta.id = bookId; // a copied folder answers to its own name
      return meta;
    }
    // iCloud (on older macOS) holds a file it hasn't downloaded as ".book.json.icloud":
    // the book is there, just not here yet. Rebuilding it would put a bare book.json over
    // the real one.
    if (fs.existsSync(path.join(dir, '.book.json.icloud'))) return null;
    return rebuildBookMeta(bookId);
  }

  // `known` is every chapter the window holds or has held for this book. When book.json on
  // disk lists one it has never seen, another device added a chapter since this window last
  // looked.
  function unseenChapters(file: string, known: string[]): string[] {
    let disk: { chapterOrder?: unknown } | null = null;
    try {
      if (icloud.isCloudOnly(file)) return [];
      disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return []; } // no book.json yet, or one that can't be read: nothing to compare
    if (!disk || !Array.isArray(disk.chapterOrder)) return [];
    const seen = new Set(known);
    return disk.chapterOrder.filter((c): c is string => typeof c === 'string' && !seen.has(c));
  }

  // the disk copy is not exactly what this device last knew (`expected`) and is not already
  // the new text (a retry or an identical write), and it holds words. Any other revision,
  // formatting, order and deletions included, is a conflict: the disk text is handed back to
  // be kept as a twin before anything is replaced.
  function chapterDiverged(cur: string, expected: string, html: string): boolean {
    if (cur === expected || cur === html) return false;
    const words = String(cur || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim();
    return words !== '';
  }

  const chapterFile = (bookId: string, chapterId: string) => path.join(bookDir(bookId), 'chapters', libName(chapterId) + '.html');

  // a file that cannot be read says which kind of cannot: absent, or something else
  function readFailure(err: unknown): StoreError {
    const e = err as NodeJS.ErrnoException;
    return new StoreError(e && e.code === 'ENOENT' ? 'not_found' : 'unreadable', String(e && e.message || e), { cause: err });
  }
  function readText(file: string): string {
    try { return fs.readFileSync(file, 'utf8'); } catch (err) { throw readFailure(err); }
  }

  // null for a page that is not there; anything else that stops a read is raised as it is
  function readAuxFile(file: string): string | null {
    try { return fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  // The displaced disk text is kept as <page>.bak, or .bak2, .bak3 ... when that name holds
  // other words. A retry that finds its own copy already there adds nothing.
  function keepAuxBackup(file: string, text: string): string {
    for (let n = 1; n < 1000; n++) {
      const bak = file + (n === 1 ? '.bak' : '.bak' + n);
      const have = readAuxFile(bak);
      if (have === text) return bak;
      if (have === null) { writeFileDurable(bak, text); return bak; }
    }
    throw new Error('too many kept copies of ' + path.basename(file));
  }

  // Snapshots of a book: book-.../snapshots/<name>/ holds the chapters that changed since
  // the snapshot before it and, written last, its snapshot.json. A snapshot's files are
  // written once and never rewritten, so a sync tool only ever sees new files arrive and two
  // devices have nothing to clash over. The window decides what to keep; the store lists,
  // reads, writes a new file and removes a snapshot the window has already carried forward.
  function snapshotDir(bookId: string, name: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(libName(name))) throw new StoreError('bad_name', 'Invalid snapshot name');
    return path.join(bookDir(bookId), 'snapshots', name);
  }
  function snapshotFile(bookId: string, name: string, file: string): string {
    if (!/^[\w-][\w.-]*\.(html|json)$/.test(libName(file))) throw new StoreError('bad_name', 'Invalid snapshot file');
    return path.join(snapshotDir(bookId, name), file);
  }
  const sidecar = (bookId: string, name: string) => path.join(bookDir(bookId), libName(name) + '.json');

  return {
    root,

    async readLibrary() {
      ensureLibrary();
      return icloud.afterLocal([libraryFile], readLibraryFile, () => { throw icloud.cloudError(libraryFile); });
    },

    async writeLibrary(data) {
      ensureLibrary();
      writeJSON(libraryFile, data);
      writeCatalog();
      return true;
    },

    async peekLibrary() {
      const lib = readJSON(libraryFile, null);
      return lib && typeof lib === 'object' && !Array.isArray(lib) ? (lib as LibraryRecord) : null;
    },

    async listBooks() {
      let metas: string[] = [];
      try { metas = fs.readdirSync(root).filter((d) => d.startsWith('book-')).map((d) => path.join(root, d, 'book.json')); } catch { /* no library */ }
      return icloud.afterLocal(metas, listBooksSync, () => listBooksSync());
    },

    // A book is a folder: book.json + chapters/*.html + notes.html + outline.html + darlings.json
    async createBook(meta) {
      ensureLibrary();
      const id = newBookId(meta.title);
      const dir = bookDir(id);
      fs.mkdirSync(path.join(dir, 'chapters'), { recursive: true });
      const book: BookMeta = {
        id,
        title: meta.title || t('Untitled'),
        subtitle: '',
        series: '',
        author: meta.author || t('Anonymous'),
        wordGoal: 0,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        chapterOrder: [],
        tabNames: { notes: 'Notes', outline: 'Outline' }, // shown translated (see tabName in app/)
      };
      writeJSON(path.join(dir, 'book.json'), book);
      fs.writeFileSync(path.join(dir, 'notes.html'), '');
      fs.writeFileSync(path.join(dir, 'outline.html'), '');
      writeJSON(path.join(dir, 'darlings.json'), []);
      writeJSON(path.join(dir, 'stickies.json'), []);
      return book;
    },

    // A copy of a book, for a backup or a version to play with: every file in its folder
    // (chapters, notes, darlings, covers) written whole into a new folder, then its
    // book.json under the new id and title. A half-made copy is removed; the original is
    // only ever read.
    async duplicateBook(bookId, title) {
      ensureLibrary();
      const src = bookDir(bookId);
      const meta = readJSON(path.join(src, 'book.json'), null) as BookMeta | null;
      if (!meta) throw new StoreError('unreadable', 'That book could not be read');
      const id = newBookId(title);
      const dest = bookDir(id);
      // a chapter iCloud hasn't brought down yet would be missing from the copy
      const waiting = (dir: string): boolean => fs.readdirSync(dir, { withFileTypes: true }).some((e) => (e.isDirectory() ? waiting(path.join(dir, e.name)) : /\.icloud$/.test(e.name)));
      const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
      const away = icloud.cloudOnlyAmong(files(src));
      if (away.size) icloud.requestDownload(away);
      if (away.size || waiting(src)) throw new StoreError('cloud_only', 'Some of this book is still downloading from iCloud. Try again in a moment');
      const copyDir = (from: string, to: string) => {
        fs.mkdirSync(to, { recursive: true });
        for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
          // (a write caught halfway, a spare copy, a placeholder: not the book)
          if (/\.(tmp|bak|icloud)$/.test(ent.name) || ent.name === 'book.json') continue;
          const a = path.join(from, ent.name);
          const b = path.join(to, ent.name);
          if (ent.isDirectory()) copyDir(a, b);
          else if (ent.isFile()) writeFileDurable(b, fs.readFileSync(a));
        }
      };
      try {
        copyDir(src, dest);
        const now = new Date().toISOString();
        const copy: BookMeta = { ...meta, id, title: title || (meta.title as string), created: now, modified: now };
        delete copy.uuid; // an ebook store sees a new book
        writeJSON(path.join(dest, 'book.json'), copy);
        writeCatalog();
        return copy;
      } catch (err) {
        log('duplicate', err);
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* left for the writer */ }
        throw err;
      }
    },

    async readBookMeta(bookId) {
      const dir = bookDir(bookId);
      // a book.json iCloud never brings down is a book that's there, just not here yet:
      // null, as for the older ".icloud" stand-in
      return icloud.afterLocal([path.join(dir, 'book.json')], () => readBookMetaSync(bookId), () => null);
    },

    // book.json is saved whole at every pause in typing; written blind, it dropped the
    // other device's new chapter from the book, its words left in a file no list named. So
    // when disk lists a chapter the window has not seen, nothing is written and the window
    // is told, and takes the chapter in first.
    async writeBookMeta(bookId, meta, known) {
      const file = path.join(bookDir(bookId), 'book.json');
      if (Array.isArray(known)) {
        const unseen = unseenChapters(file, known);
        if (unseen.length) { log('book.json', `${bookId}: another device added ${unseen.length} chapter(s); save held back`); return { unseen }; }
      }
      meta.modified = new Date().toISOString();
      writeJSON(file, meta);
      writeCatalog();
      return meta.modified as string;
    },

    async trashBook(bookId, mover) {
      const dir = bookDir(bookId);
      try {
        await mover.trash(dir);
        return true;
      } catch (err) {
        // Some filesystems have no Trash (network mounts, odd drives). Words are never
        // lost: leave the book alone and show the writer where it lives.
        log('trash', err);
        mover.reveal(dir);
        return false;
      }
    },

    // {chapterId: mtime and size} for a book's chapter files: how the window tells what
    // changed without re-reading every chapter. The size is there because sync tools hand
    // over the other device's mtime, and on disks that keep whole seconds two saves a second
    // apart would otherwise look the same.
    async chapterStamps(bookId) {
      const out: Record<string, string> = {};
      try {
        const dir = path.join(bookDir(bookId), 'chapters');
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.html')) continue;
          try {
            const st = fs.statSync(path.join(dir, f));
            out[f.slice(0, -5)] = st.mtimeMs + ':' + st.size;
          } catch { /* vanished */ }
        }
      } catch { /* no chapters folder yet */ }
      return out;
    },

    // An empty answer that is then saved would wipe the chapter, so a chapter that cannot be
    // read is an error: not_found (no file yet), unreadable, or cloud_only.
    async readChapter(bookId, chapterId) {
      const file = chapterFile(bookId, chapterId);
      return icloud.afterLocal([file], () => readText(file), () => { throw icloud.cloudError(file); });
    },

    // `expected` is the text the window last read or wrote for this chapter. When the file
    // holds something else (another device wrote it since, even if only formatting, order
    // or a deletion changed), nothing is written: the window is handed that text to keep as
    // its own chapter first, so neither version is lost to a save that happened before the
    // next look at the disk.
    async writeChapter(bookId, chapterId, html, expected) {
      const file = chapterFile(bookId, chapterId);
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // still in iCloud: the words there aren't known yet, so nothing goes over them. The
      // save fails, and the next one tries again.
      if (icloud.isCloudOnly(file)) { icloud.requestDownload([file]); throw icloud.cloudError(file); }
      if (typeof expected === 'string') {
        let cur: string | null = null;
        try { cur = fs.readFileSync(file, 'utf8'); } catch { /* not there: nothing to keep */ }
        if (cur !== null && chapterDiverged(cur, expected, html)) {
          log('conflict', `${bookId}/${chapterId}: another device changed this chapter since it was read; its text is handed back to be kept, nothing written`);
          return { conflict: cur };
        }
      }
      writeFileDurable(file, html);
      return true;
    },

    async deleteChapter(bookId, chapterId) {
      const file = chapterFile(bookId, chapterId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return true;
    },
    // A page the disk can't read is an error, never an empty page: an empty read that is
    // then saved would wipe the page. A page the book has never had is null.
    async readAux(bookId, name) {
      // name: 'notes' | 'outline' | 'notes-<chapter>'
      const file = path.join(bookDir(bookId), libName(name) + '.html');
      const read = () => { try { return readAuxFile(file); } catch (err) { throw readFailure(err); } };
      return icloud.afterLocal([file], read, () => { throw icloud.cloudError(file); });
    },

    // `expected` is the text the window last read or wrote for this page (as for chapters).
    // When the file holds words the new text lacks, another device wrote it since: the
    // file's text is kept as a .bak beside the page before the new text goes in, so neither
    // version is lost.
    async writeAux(bookId, name, html, expected) {
      const file = path.join(bookDir(bookId), libName(name) + '.html');
      if (icloud.isCloudOnly(file)) { icloud.requestDownload([file]); throw icloud.cloudError(file); }
      let kept: string | null = null;
      if (typeof expected === 'string') {
        const cur = readAuxFile(file);
        if (cur !== null && chapterDiverged(cur, expected, html)) {
          kept = keepAuxBackup(file, cur);
          log('conflict', `${bookId}/${name}: another device changed this page since it was read; its text is kept as ${path.basename(kept)}`);
        }
      }
      writeFileDurable(file, html);
      return kept ? { kept: path.basename(kept) } : true;
    },

    async listSnapshots(bookId) {
      const dir = path.join(bookDir(bookId), 'snapshots');
      let names: string[] = [];
      try { names = fs.readdirSync(dir).filter((n) => /^[A-Za-z0-9-]+$/.test(n)); } catch { return []; }
      const out = [];
      for (const name of names) {
        try { out.push({ name, files: fs.readdirSync(path.join(dir, name)).filter((f) => /\.(html|json)$/.test(f)) }); } catch { /* not a folder */ }
      }
      return out;
    },

    // A file that can't be read throws (missing, no permission, still in iCloud): only a
    // chapter that is really empty reads as ''. Thinning relies on telling them apart, so it
    // never carries an empty stand-in forward.
    async readSnapshotFile(bookId, name, file) {
      const fp = snapshotFile(bookId, name, file);
      return icloud.afterLocal([fp], () => readText(fp), () => { throw icloud.cloudError(fp); });
    },

    async writeSnapshotFile(bookId, name, file, text) {
      const target = snapshotFile(bookId, name, file);
      if (fs.existsSync(target)) return false; // written once
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileDurable(target, text);
      return true;
    },

    async removeSnapshot(bookId, name) {
      try { fs.rmSync(snapshotDir(bookId, name), { recursive: true, force: true }); } catch (err) { log('snapshot remove', err); }
      return true;
    },

    async readJSON(bookId, name, fallback) {
      return readJSON(sidecar(bookId, name), fallback);
    },

    async writeJSON(bookId, name, data) {
      writeJSON(sidecar(bookId, name), data);
      return true;
    },
  };
}
