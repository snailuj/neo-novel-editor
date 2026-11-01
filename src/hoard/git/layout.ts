// The gate's own layout of a library, for running lint's frontmatter rules over a page's
// sidecar. It is not HOARD_LAYOUT (librarian/scheme.ts), the hoard vault CLI's layout, where
// `sources/` is a zone of author bodies and marks: a rule about that zone must never reach
// the library's `sources/` tree. Both trees count as librarian-kept, so every frontmatter
// rule judges them; no other zone is named, so no body or mark rule runs.
import type { Layout } from '../../librarian/scheme.ts';

/** A sidecar's frontmatter goes back into a note at this path; its folder puts the note in a judged zone. */
export const PAGE_PATH = 'wiki/page.md';

// The single-name fields point at paths no page of a library can have (a hidden folder),
// so none of them ever matches.
export const LIBRARY_LAYOUT: Layout = Object.freeze({
  librarianDirs: ['wiki/', 'sources/'],
  asIsDirs: [],
  skipDirs: [],
  authorBodyDirs: [],
  writingDir: '.neo/none/',
  librarianAuthoredDirs: [],
  captureDirs: [],
  markDirs: [],
  deprecatedDir: '.neo/none/',
  indexPage: '.neo/none.md',
  manifestPath: '.neo/manifest.jsonl',
  logPath: '.neo/none.md',
}) as Layout;
