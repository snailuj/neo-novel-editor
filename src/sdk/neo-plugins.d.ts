// The plugin API, versions 1 and 2, as types. plugins.js implements the window half
// (what activate(neo) receives) and plugins-main.js the main half (what a manifest's
// `main` entry's activate(host) receives); this file follows them.

// ---- Window half -------------------------------------------------------------------

/**
 * A place in the open book: captureCaret's shape (app.js) plus a length. pIdx indexes
 * the chapter's paragraphs on the page, as chapter(chId).paragraphs counts them; off
 * and len are UTF-16 units of the paragraph's text, counted across any inline elements
 * as captureCaret counts them, so an emoji is two units and a placeholder's flag one.
 * A place lies inside one paragraph. NeoPlugins.validPlace checks the shape.
 */
interface NeoPlace {
  chId: string;
  /** Whole number, 0 or more. */
  pIdx: number;
  /** Whole number, 0 or more. */
  off: number;
  /**
   * Whole number, 0 or more. From where() and the selection event: the length selected
   * when the selection starts and ends in one paragraph, else 0.
   */
  len: number;
  /** The page's scrollTop, a finite number of 0 or more. Only go uses it. */
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
  /** The chapters were drawn anew; the host has already rebuilt every highlight. */
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

/** What activate(neo) receives for API 1. */
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
   * returns, and rejects with an Error that names the plugin and the channel and carries
   * the handler's message (the handler's error is logged once in neo-errors.log, with its
   * stack). A channel matches ^[a-z][a-z0-9.-]{0,63}$.
   * The plugin's id is filled in for it, which prevents mistakes but is no wall: every
   * plugin's script runs in NEO's page, and any of them can reach any main half.
   * Rejects without calling when the plugin is not active (its activate failed).
   * NEO does not log a refusal (a bad channel, a channel the main half never took); it
   * rejects to the caller.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

/**
 * Why replace changed nothing. A refusal is final: nothing queues or retries it.
 * - busy: an input method is composing a word.
 * - hidden: no book is open or it is closing (an edit then would miss the save that
 *   closes the book), or the writer is off the manuscript.
 * - missing: the place is not on the page, by the rules go uses.
 * - stale: the text at the place is not expectedText.
 * - blocked: the plugin failed to activate; the place is on a ghost line (an outline
 *   note) or in a chapter the writer cannot type in; a beforeinput listener cancelled
 *   the edit, or the editor would not make it; or the paragraph came out other than
 *   asked, in which case an edit the editor made is undone.
 */
type NeoReplaceRefusal = 'busy' | 'hidden' | 'missing' | 'stale' | 'blocked';

type NeoReplaceResult = { ok: true } | { ok: false; reason: NeoReplaceRefusal };

/** What activate(neo) receives for API 2: API 1, plus where, go, replace and highlight. */
interface NeoApiV2 extends NeoApi {
  /**
   * Where the writer is: the caret's place, with len the length selected when the
   * selection starts and ends in one paragraph, else 0, and the page's scroll. null with
   * no book open, off the manuscript, or with no caret in a chapter.
   */
  where(): NeoPlace | null;
  /**
   * Takes the writer to a place: switches to the manuscript, puts the caret at the
   * place's start and selects off to off + len. With scroll given the page scrolls
   * there, else the caret sits a third of the way down, as when a book opens. Returns
   * false, with nothing moved, when the place is not in the open book (its chapter is
   * not drawn or not in the book's order, its paragraph is not there, it runs past the
   * paragraph's end, or either end falls inside a character) or the plugin failed to
   * activate; false, with nothing selected, when the place is gone once the manuscript
   * is up. Throws TypeError for a value that is not a place.
   */
  go(place: NeoPlace): boolean;
  /**
   * Rewrites the text at a place through the editor, as typing writes it: the writer's
   * undo takes it back, and NEO saves it as it saves typing. The writer's selection,
   * focus and scroll stay where they were, the selection's ends moving with the text
   * after the edit in its paragraph; the place's scroll plays no part. Before the
   * edit the chapter receives a synthetic, bubbling, cancelable beforeinput event
   * (inputType 'insertText', data newText) that every beforeinput listener sees, NEO's
   * and any plugin's; a listener that cancels it refuses the edit as blocked.
   * Rejects with TypeError for a value that is not a place, an expectedText that is not
   * a string of exactly place.len UTF-16 units, or a newText that is not a string or
   * holds a line break (\r or \n).
   */
  replace(place: NeoPlace, expectedText: string, newText: string): Promise<NeoReplaceResult>;
  /**
   * Marks places on the page under a name, with the CSS Highlight API, in place of what
   * the name marked before; an empty list clears it. The page's CSS highlights hold it
   * as plugin-<id>-<name>, which the plugin's own stylesheet styles with
   * ::highlight(plugin-<id>-<name>). Nothing reaches the chapter's HTML, its file or the
   * undo history. The host keeps copies of the places (their scroll is ignored) and
   * builds the marks again from them each time the chapters are drawn anew, before
   * rendered is heard; a place not on the page, by the rules go uses, is left out.
   * Between drawings the marks move with the writer's typing, but the places kept do
   * not, so after a redraw a mark can sit on other text: send the places again on
   * chapter-change or rendered. Highlights are cleared when the book closes and are not
   * restored when it opens again; with no book open nothing is kept. They are cleared
   * when the plugin fails to activate, and a plugin that failed marks nothing.
   * Throws TypeError for a name that does not match ^[a-z][a-z0-9-]{0,31}$, a places
   * value that is not an array, an item that is not a place, or a key another plugin
   * holds: plugin ab's 'c-d' and plugin ab-c's 'd' are both plugin-ab-c-d, which belongs
   * to the first to mark it until that plugin clears it.
   */
  highlight(name: string, places: readonly NeoPlace[]): void;
}

interface NeoPluginBase {
  /** The id in the plugin's plugin.json. */
  id: string;
}

/**
 * A plugin's apiVersion must be the one its plugin.json gives, and one of
 * NeoPlugins.apiVersions; else it is refused and the refusal logged.
 * activate is called once the plugin registers. A throw, or a rejected promise, is
 * logged and takes away everything the plugin added. When a book is already open, the
 * plugin then hears book-open for it; an async activate hears it after it settles.
 */
interface NeoPluginV1 extends NeoPluginBase {
  apiVersion: 1;
  activate(neo: NeoApi): void | Promise<void>;
}

interface NeoPluginV2 extends NeoPluginBase {
  apiVersion: 2;
  activate(neo: NeoApiV2): void | Promise<void>;
}

type NeoPlugin = NeoPluginV1 | NeoPluginV2;

declare const NeoPlugins: {
  readonly apiVersions: readonly (1 | 2)[];
  register(plugin: NeoPlugin): void;
  /**
   * true when a value is a place: an object with chId a non-empty string, pIdx, off and
   * len whole numbers of 0 or more, scroll absent or a finite number of 0 or more, and
   * no other keys. It says nothing of whether the place is in the open book.
   */
  validPlace(value: unknown): value is NeoPlace;
};

// ---- Main half ---------------------------------------------------------------------

/** A write from the window that has landed. name is 'book' for book.json. */
interface NeoAfterWrite {
  readonly kind: 'chapter' | 'aux' | 'json' | 'meta';
  readonly bookId: string;
  readonly name: string;
}

/**
 * What a main entry's activate(host) receives. NEO calls activate once the window has its
 * plugin list, on its main thread: what runs before activate's first await delays NEO's
 * other work, so heavy work belongs after it. An activate that returns a promise has
 * 10 s to settle. Past that, NEO logs once that the plugin did not finish activating and
 * refuses its invokes from then on, with an Error that says so, even if the promise
 * settles later; handlers and listeners the plugin added are dropped.
 */
interface NeoMainHost {
  readonly id: string;
  /**
   * Answers neo.invoke(channel, payload) from this plugin's window half. Throws
   * TypeError for a name that is no channel or a channel that has a handler already.
   * Any script in NEO's page can reach the handler, not only this plugin's window half.
   */
  handle(channel: string, fn: (payload: unknown) => unknown): void;
  /**
   * The plugin's own object under plugins[id] in NEO's settings.json. Both throw when
   * settings.json is there but cannot be read or parsed; set then writes nothing.
   */
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
