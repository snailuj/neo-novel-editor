// The one interface the main process reads and writes a library through. Today the only
// implementation is the local folder (fs-store.ts); the server-backed store will sit behind
// the same methods. Everything is async because that one will be.

export type StoreErrorCode = 'not_found' | 'cloud_only' | 'unreadable' | 'bad_name' | 'exists' | 'blocked';

const CODES: readonly string[] = ['not_found', 'cloud_only', 'unreadable', 'bad_name', 'exists', 'blocked'];

// Electron passes only the message across IPC, and wraps it ("Error invoking remote method
// 'x': Error: ..."), so the code is the `[store:<code>]` marker the message carries.
export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(`[store:${code}] ${message}`, options);
    this.name = 'StoreError';
    this.code = code;
  }
}

export function storeErrorCode(error: unknown): StoreErrorCode | undefined {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined;
  const code = message === undefined ? undefined : /\[store:([a-z_]+)\]/.exec(message)?.[1];
  return code !== undefined && CODES.includes(code) ? (code as StoreErrorCode) : undefined;
}

/** Where the store reports what it did and what it recovered from. */
export type Log = (source: string, detail: unknown) => void;

export type Translate = (text: string) => string;

export type Json = unknown;
export type LibraryRecord = Record<string, unknown>;
export type BookMeta = Record<string, unknown> & { id: string; chapterOrder: string[] };

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  modified: string;
  kind: string;
}

/** An image of a book, as the window shows it: base64 with its type. */
export interface CoverImage {
  base64: string;
  mime: string;
  ext: string;
}

/** A painted cover: the image, and what art.json keeps beside it so a repaint can start from the brief. */
export interface Painting {
  buffer: Uint8Array;
  /** png, jpg or webp; jpg when absent. */
  ext?: string;
  art: Record<string, unknown>;
}

export interface SnapshotListing {
  name: string;
  files: string[];
}

/** The backup's process: Electron's utilityProcess in the app, a plain Node child in tests. */
export interface BackupWorker {
  on(event: 'message', fn: (message: unknown) => void): void;
  on(event: 'exit', fn: (code: number) => void): void;
  postMessage(message: unknown): void;
  kill(): void;
}

/** Starts a process on `script`. Only Electron can make the real one, so the caller passes it in. */
export type ForkWorker = (script: string, options: { serviceName: string }) => BackupWorker;

export interface BackupOptions {
  /** Where backup-worker.js is; beside the app by default. */
  workerPath?: string;
  /** The whole job; 15 minutes by default. */
  totalMs?: number;
  /** One file; 20 seconds by default. */
  fileMs?: number;
}

/** What the window reads and writes of the library. Read failures are StoreErrors. */
export interface LibraryStore {
  /** Makes the folder and a one-shelf library.json when the library is new, and marks the library open. Throws when the folder cannot be made. */
  open(): Promise<void>;
  /**
   * Adds a line to the library's neo-errors.log. False, with nothing made, when the library is not open, its
   * folder is gone or the log cannot be written: the caller keeps the line somewhere else.
   */
  appendErrorLog(line: string): Promise<boolean>;
  /** library.json, made if the library is new, recovered if damaged. */
  readLibrary(): Promise<LibraryRecord>;
  writeLibrary(data: LibraryRecord): Promise<true>;
  /** library.json as it is, with no waiting, seeding or rebuilding; null when absent or not an object. */
  peekLibrary(): Promise<LibraryRecord | null>;
  listBooks(): Promise<BookSummary[]>;

  createBook(meta: { title?: string; author?: string }): Promise<BookMeta>;
  duplicateBook(bookId: string, title?: string): Promise<BookMeta>;
  /** null when the book is there but iCloud has not brought its book.json down. */
  readBookMeta(bookId: string): Promise<BookMeta | null>;
  /** The new `modified`, or `{ unseen }` (nothing written) when disk lists chapters `known` lacks. */
  writeBookMeta(bookId: string, meta: BookMeta, known?: string[]): Promise<string | { unseen: string[] }>;
  /** Hands the folder to `mover`; false when it could not go (the book is untouched). */
  trashBook(bookId: string, mover: BookMover): Promise<boolean>;

  chapterStamps(bookId: string): Promise<Record<string, string>>;
  /** Throws not_found for a chapter with no file yet, unreadable, cloud_only. */
  readChapter(bookId: string, chapterId: string): Promise<string>;
  writeChapter(bookId: string, chapterId: string, html: string, expected?: string): Promise<true | { conflict: string }>;
  deleteChapter(bookId: string, chapterId: string): Promise<true>;

  /** A notes or outline page; null when the book has no such page yet. Throws unreadable, cloud_only. */
  readAux(bookId: string, name: string): Promise<string | null>;
  writeAux(bookId: string, name: string, html: string, expected?: string): Promise<true | { kept: string }>;

  listSnapshots(bookId: string): Promise<SnapshotListing[]>;
  readSnapshotFile(bookId: string, name: string, file: string): Promise<string>;
  /** false when the file already exists: a snapshot's files are written once. */
  writeSnapshotFile(bookId: string, name: string, file: string, text: string): Promise<boolean>;
  removeSnapshot(bookId: string, name: string): Promise<true>;

  readJSON(bookId: string, name: string, fallback: Json): Promise<Json>;
  writeJSON(bookId: string, name: string, data: Json): Promise<true>;

  /** Copies the picked image in as the book's cover and removes the older ones; its name, or null for a file that is not an image or a book that is not there. */
  setCover(bookId: string, sourcePath: string): Promise<string | null>;
  removeCover(bookId: string): Promise<true>;
  /** A cover or painting by name; null when it is not there, not an image name, or still in iCloud. */
  readCover(bookId: string, name: string): Promise<CoverImage | null>;
  hasBook(bookId: string): Promise<boolean>;
  /**
   * A look over the whole library, without reading a word, for files iCloud has taken off this
   * Mac, which it is then asked to bring back so the books are here before they are opened. How
   * many it asked for; 0 off a Mac.
   */
  fetchFromICloud(): Promise<number>;
  /** A PDF into the library's Exports/ folder as `<name>-<time>.pdf`; the file it made. Throws bad_name for a name that is a path. */
  writeExport(name: string, data: Uint8Array): Promise<string>;
  /**
   * One zip of the whole library for the day, in Backups/, keeping the last 14. It is made in a
   * process of its own (backup-worker.js), which leaves out and names any file that is not
   * handed over in time. One at a time, one a day; resolves when it is done, and never rejects:
   * a failure is logged.
   */
  backup(fork: ForkWorker, options?: BackupOptions): Promise<void>;
  /**
   * The new painting and the art.json naming it are written before the older paintings go,
   * so art.json never names a file that is not there. Throws not_found for a book that is not there.
   */
  writePainting(bookId: string, painting: Painting): Promise<string>;
}

/** The two things only Electron's shell can do with a book folder. */
export interface BookMover {
  trash(folder: string): Promise<void>;
  reveal(folder: string): void;
}
