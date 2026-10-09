// The plugin API, version 1, as types. plugins.js implements the window half (what
// activate(neo) receives) and plugins-main.js the main half (what a manifest's `main`
// entry's activate(host) receives); this file follows them.

// ---- Window half -------------------------------------------------------------------

/** Where the writer is: captureCaret's shape, plus the length selected. */
interface NeoPlace {
  chId: string;
  /** The paragraph's index, as chapter(chId).paragraphs counts them. */
  pIdx: number;
  /** UTF-16 units into the paragraph's text. */
  off: number;
  /** The length selected when the selection starts and ends in one paragraph, else 0. */
  len: number;
  /** Layout state, not part of the place itself. */
  scroll?: number;
}

/** Each event's detail. Every listener of an event is handed the same frozen object. */
interface NeoEvents {
  'book-open': { readonly bookId: string };
  'book-close': { readonly bookId: string };
  /** At most once a frame for each chapter that changed. */
  'chapter-change': { readonly bookId: string; readonly chId: string };
  'chapter-saved': { readonly bookId: string; readonly chId: string };
  /** At most once a frame; place is null off the manuscript. */
  selection: { readonly place: Readonly<NeoPlace> | null };
  rendered: { readonly bookId: string };
}

type NeoEventName = keyof NeoEvents;

/** A copy of the open book's book.json. */
interface NeoBook {
  id: string;
  title?: string;
  chapterOrder: string[];
  [key: string]: unknown;
}

/** A chapter of the open book: its HTML as NEO holds it, and each paragraph's text. */
interface NeoChapter {
  id: string;
  html: string;
  paragraphs: string[];
}

/** What activate(neo) receives. */
interface NeoApi {
  /** Throws TypeError for an event name it does not know. Returns the unsubscribe. */
  on<E extends NeoEventName>(event: E, fn: (detail: NeoEvents[E]) => void | Promise<void>): () => void;
  /** A copy of the open book; null on the shelf and while a shelf export borrows a book. */
  book(): NeoBook | null;
  /** A chapter of the open book, or null. */
  chapter(chId: string): NeoChapter | null;
  /**
   * A tab of the plugin's own beside Notes, Outline and Darlings, named
   * plugin:<plugin>:<id>, and the element shown under its title when the writer opens
   * it. Throws TypeError for an id that does not match ^[a-z][a-z0-9-]{0,31}$, a blank
   * title, or an id added already.
   */
  addPane(pane: { id: string; title: string }): { readonly element: HTMLDivElement };
  /**
   * Binds the handler for a command the plugin's plugin.json declares, run from the
   * Plugins menu; a throw or a rejection is logged each time. Throws TypeError for a
   * command the plugin.json does not declare, a run that is not a function, or a
   * command bound already.
   */
  addCommand(commandId: string, run: () => void | Promise<void>): void;
  /**
   * The plugin's one quiet line among the counters, in a slot made the first time it
   * has something to say; '' hides it. Throws TypeError for anything but a string.
   */
  status(text: string): void;
  /**
   * Calls the plugin's own main half: resolves with what its handler for the channel
   * returns, and rejects with its error. A channel matches ^[a-z][a-z0-9.-]{0,63}$.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

interface NeoPlugin {
  /** The id in the plugin's plugin.json. */
  id: string;
  apiVersion: 1;
  /**
   * Called once the plugin registers. A throw, or a rejected promise, is logged and
   * takes away everything the plugin added. When a book is already open, the plugin
   * then hears book-open for it; an async activate hears it after it settles.
   */
  activate(neo: NeoApi): void | Promise<void>;
}

declare const NeoPlugins: {
  readonly apiVersions: readonly number[];
  register(plugin: NeoPlugin): void;
};

// ---- Main half ---------------------------------------------------------------------

/** A write from the window that has landed. name is 'book' for book.json. */
interface NeoAfterWrite {
  readonly kind: 'chapter' | 'aux' | 'json' | 'meta';
  readonly bookId: string;
  readonly name: string;
}

/** What a main entry's activate(host) receives. */
interface NeoMainHost {
  readonly id: string;
  /**
   * Answers neo.invoke(channel, payload) from this plugin's window half. Throws
   * TypeError for a name that is no channel or a channel that has a handler already.
   */
  handle(channel: string, fn: (payload: unknown) => unknown): void;
  /** The plugin's own object under plugins[id] in NEO's settings.json. */
  readonly settings: {
    get(): Record<string, unknown>;
    set(settings: Record<string, unknown>): void;
  };
  readonly paths: {
    /** The library folder as it is now. */
    library(): string;
    /** NEO's own app-data folder. */
    readonly userData: string;
    /** The plugin's own folder. */
    readonly plugin: string;
  };
  /** error and warn go to neo-errors.log, info and debug to the console. */
  log(level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown): void;
  /** Heard after the window has its answer; returns the unsubscribe. */
  onAfterWrite(fn: (event: NeoAfterWrite) => void | Promise<void>): () => void;
}
