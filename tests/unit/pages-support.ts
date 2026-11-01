// Shared by the page store's tests: a temporary library, a store over it, and the log it
// wrote. Every page here is a neutral word; none comes from a real manuscript.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PageStore, type PageStoreOptions } from '../../src/hoard/pages/store.ts';
import { tempDir } from './git-support.ts';

export interface LogLine { level: string; message: string; data?: unknown }

export function pagesLibrary(t: { after(fn: () => void): void }, extra: Partial<PageStoreOptions> = {}) {
  const library = tempDir(t, 'hoard-pages-');
  const lines: LogLine[] = [];
  const log = (level: string, message: string, data?: unknown) => { lines.push({ level, message, data }); };
  const store = new PageStore({ library: () => library, log, ...extra });
  const put = (rel: string, text: string) => {
    const file = path.join(library, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const get = (rel: string) => readFileSync(path.join(library, rel), 'utf8');
  const has = (rel: string) => existsSync(path.join(library, rel));
  const logged = (message: string) => lines.filter((l) => l.message === message);
  return { library, store, log, lines, put, get, has, logged };
}
