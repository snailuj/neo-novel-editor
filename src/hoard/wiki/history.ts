// The wiki pane's trail of pages, as a browser keeps one. A stop is a stored page id
// (wiki/... or sources/...). Pure.
export class PageHistory {
  #trail: string[] = [];
  #at = -1;

  get current(): string | null {
    return this.#trail[this.#at] ?? null;
  }

  get canBack(): boolean {
    return this.#at > 0;
  }

  get canForward(): boolean {
    return this.#at < this.#trail.length - 1;
  }

  /** A new page: what was ahead goes. The page already shown is not a new stop. */
  visit(id: string): void {
    if (this.current === id) return;
    this.#trail = [...this.#trail.slice(0, this.#at + 1), id];
    this.#at = this.#trail.length - 1;
  }

  /** A page renamed: its stops name the new id, and stops side by side that now match are one. */
  rename(oldId: string, newId: string): void {
    if (!this.#trail.includes(oldId)) return;
    const trail: string[] = [];
    let at = -1;
    this.#trail.forEach((id, i) => {
      const now = id === oldId ? newId : id;
      if (trail[trail.length - 1] !== now) trail.push(now);
      if (i === this.#at) at = trail.length - 1;
    });
    this.#trail = trail;
    this.#at = at;
  }

  back(): string | null {
    if (!this.canBack) return null;
    return this.#trail[--this.#at]!;
  }

  forward(): string | null {
    if (!this.canForward) return null;
    return this.#trail[++this.#at]!;
  }
}
