// The host keeps one list of held chapters for each plugin, and each hold() replaces it.
// hoard holds chapters for more than one reason (a librarian edit now, a page that takes
// suggestions later), so its reasons are gathered here: a chapter stays held while any
// of them holds it.
export class Holds {
  readonly #send: (chIds: string[]) => void;
  readonly #by = new Map<object, readonly string[]>();

  constructor(send: (chIds: string[]) => void) {
    this.#send = send;
  }

  /** Holds the chapters until the returned function is called; calling it again does nothing. */
  hold(chIds: readonly string[]): () => void {
    const key = {};
    this.#by.set(key, [...chIds]);
    this.#update();
    return () => {
      if (this.#by.delete(key)) this.#update();
    };
  }

  #update(): void {
    this.#send([...new Set([...this.#by.values()].flat())]);
  }
}
