import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createFsStore, createICloud, createJsonFiles, type BookMeta, type LibraryStore } from '../../../src/store/index.ts';

// A store over a throwaway library folder, with iCloud played by the test: a file in `away`
// is a placeholder, and one with an entry in `arrive` comes back that many ms after it is asked for.
export interface Harness {
  dir: string;
  store: LibraryStore;
  logs: string[];
  away: Set<string>;
  asked: string[];
  arrive: Map<string, string>;
  at(...parts: string[]): string;
  read(...parts: string[]): string;
  write(parts: string[], text: string): void;
  withBook(chapters?: Record<string, string>): Promise<BookMeta>;
}

export function harness(options: { dir?: string; t?: (s: string) => string } = {}): Harness {
  const dir = options.dir ?? fs.mkdtempSync(path.join(tmpdir(), 'neo-store-'));
  const logs: string[] = [];
  const away = new Set<string>();
  const asked: string[] = [];
  const arrive = new Map<string, string>();
  const log = (source: string, detail: unknown) => logs.push(`${source}: ${detail instanceof Error ? detail.message : String(detail)}`);
  const icloud = createICloud({
    platform: 'darwin',
    waitMs: 300,
    pollMs: 10,
    detect: (files) => new Set(files.filter((f) => away.has(f))),
    download: (file, done) => {
      asked.push(file);
      const words = arrive.get(file);
      if (words !== undefined) setTimeout(() => { fs.writeFileSync(file, words); away.delete(file); done(); }, 30);
      else setTimeout(done, 5);
    },
  });
  const json = createJsonFiles({ log, icloud });
  const store = createFsStore({ root: dir, log, t: options.t, icloud, json });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (...parts: string[]) => path.join(dir, ...parts);
  return {
    dir, store, logs, away, asked, arrive, at,
    read: (...parts) => fs.readFileSync(at(...parts), 'utf8'),
    write: (parts, text) => { fs.mkdirSync(path.dirname(at(...parts)), { recursive: true }); fs.writeFileSync(at(...parts), text); },
    // a book on the shelf, saved twice so it has its .bak, with the given chapters written
    async withBook(chapters = { 'ch-aaa': '<p>First chapter.</p>', 'ch-bbb': '<p>Second chapter.</p>' }) {
      const lib = await store.readLibrary();
      const book = await store.createBook({ title: 'The Long Night' });
      for (const [id, html] of Object.entries(chapters)) fs.writeFileSync(at(book.id, 'chapters', id + '.html'), html);
      book.chapterOrder = Object.keys(chapters);
      await store.writeBookMeta(book.id, book);
      book.lastPosition = { chapterId: book.chapterOrder[0], scroll: 10 };
      await store.writeBookMeta(book.id, book);
      lib.firstRunDone = true;
      (lib.shelves as { bookIds: string[] }[])[0].bookIds.push(book.id);
      await store.writeLibrary(lib);
      await store.writeLibrary(lib);
      return book;
    },
  };
}
