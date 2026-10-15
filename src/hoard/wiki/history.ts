// The wiki pane's trail of pages, as a browser keeps one. Pure.
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
  visit(chId: string): void {
    if (this.current === chId) return;
    this.#trail = [...this.#trail.slice(0, this.#at + 1), chId];
    this.#at = this.#trail.length - 1;
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
