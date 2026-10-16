// Keys a hoard box acts on. NEO's own listener on the document also reads ⌘Enter
// (Ctrl+Enter), to toggle fullscreen, and doesn't look at defaultPrevented, so a key a
// box takes must also stop on its way up, or one press does both things. (Esc in a
// pane NEO takes first, on the document's way down, and goes back to the page.)

/** ⌘Enter (Ctrl+Enter): send what the box holds. */
export const submitKey = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

/** The box has acted on this key: nothing else does, the page's listeners included. */
export function claim(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}
