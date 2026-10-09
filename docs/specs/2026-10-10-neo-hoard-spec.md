# Neo-Hoard rewrite specification

Draft dated 10 October 2026. This records what the rewrite must do, as decided so far. It is not a plan; the plan for phases 0 to 3 is at `docs/plans/2026-10-10-plugin-host-phases-0-3.md`. Sources: the review of the old branch (`E:\Dev\neo-hoard\neo-hoard-review-2026-10-10.md`), the architecture assessment (`E:\Dev\neo-hoard\neo-hoard-architecture-2026-10-10.md`), the Python sizing (`E:\Dev\neo-hoard\neo-hoard-python-sizing-2026-10-10.md`) and the author's decisions of 10 October 2026.

## Purpose

Neo-Hoard replaces hoard for writing projects. Neo gains the librarian's abilities as a bundled plugin, and the hoard vault returns to a plain Obsidian arrangement without world-building machinery. Nobody uses the old branch, so there is nothing to migrate and no compatibility to keep.

## Agreed decisions

- Our layer lives inside Neo's existing renderer through a small versioned plugin host. There is no separate renderer. The librarian is the first bundled plugin. Neo's own writing tools (chapters, outline, notes, Darlings, goals, spellcheck) stay as they are.
- The hook commits to app.js, main.js, preload.js and index.html are small, separable, and free of anything hoard-specific, so they can become upstream pull requests. Until upstream takes them, they ride as a patch on the fork, rebased before each phase and each proposal.
- Upstream Neo stays plain JavaScript. Our layer is TypeScript compiled with esbuild and checked with `tsc --noEmit` strict.
- JSON Schema is the single definition for IPC messages and sidecar files. Types are generated from the schemas with a drift check. Ajv standalone validators are compiled at build time to satisfy the `script-src 'self'` CSP. Validation runs at IPC handlers, plugin API inputs and file reads, never on the typing path. `npm start` runs the build.
- No Python. The librarian is ported to TypeScript. Index work runs in a worker process, as Neo's spellchecker does. A pure-TypeScript full-text index is the starting point, behind one interface that records size and query time so a later switch to SQLite is contained.
- Git is the only history. Autosave stays an atomic file write after each 800 ms pause. Commits happen after 60 seconds idle, on switching chapter or book, on close, and immediately before and after any applied librarian edit. Librarian commits carry the librarian's identity; author commits carry the author's identity from Git config. Authorship is per paragraph, from Git blame.
- One Git repository per library, holding every book and the wiki, because books share world-building.
- Provenance JSON lives in one hidden `.neo/` folder at the library root, mirroring book and chapter paths, so the folder view stays clean and Git can still diff and blame plain files.
- Wiki pages are HTML in the library, edited in Neo with the same round trip as chapters. An Import-to-Wiki tool converts hoard or old-vault Markdown once at ingest, through the OS file picker (any local folder, including synced Drive folders; no Drive API in the first release), and ripples the changes.
- No automatic-merge sync in the first release.
- Hoard's writing-project tools are rebuilt in TypeScript inside Neo-Hoard. Ripple is redesigned for in-app use on Git history rather than ported, keeping its rulings log and the rule it enforces. The hoard-table convention waits for a later release.
- Upstream is fetched at the start of each session, and the hook commits are rebased before each phase and each upstream proposal.
- Marks are made through the pane and selection commands, never typed as `{>> <<}` syntax inside Neo. Librarian-owned pages open in suggest mode by default, with an explicit switch to direct editing.
- If the plugin host is accepted upstream, other plugins may later share it; the host's namespaced ids and IPC allow for that, and nothing more is designed for it now.

## Suggestion and review model

The author's requirement, in their words (10 October 2026):

> The current hoard librarian is an active watcher of edits, and makes suggestions through comments (which track-changes by philphilphil supports alongside the CriticMarkup). These suggestions are not prose, but references to pantsing files that I might have forgotten about, and comments on continuity errors. That sort of thing. I also have designed hoard so that I can make suggestions inside the librarian-authored files and it can either accept or flag for review. And all of that librarian functionality now needs ported to Neo-Hoard, including the comment threads and my ability to make suggestions inside librarian-owned files that it can review with me.

The model that meets it:

Participants. The author and the librarian. Each has a Git identity, and every applied change is committed under the identity of whoever applied it.

Marks. The vocabulary is CriticMarkup's five kinds, extended the way track-changes extends them: addition, deletion, substitution, comment and highlight, each carrying author, date and an optional thread. Comments reply to one another to form threads. A comment may carry references (to a wiki page, a chapter passage, a source, or a file the author has forgotten), rendered as links in the pane.

Anchoring. A mark anchors to a passage by file id, commit, exact quoted text, and prefix and suffix context, as hoard's receipts already do. There are no block ids. When the text moves, the quote re-anchors; when the quote is gone, the mark is shown as stale, never silently dropped.

Storage. Marks live in the sidecar under `.neo/`, in JSON validated against a schema, committed with the files they annotate. The CriticMarkup text syntax is not stored in chapter or wiki HTML. It appears only at Markdown boundaries: the importer parses it (porting hoard's `marks.py` and its tests), and a Markdown export writes it.

Rendering. Marks render as highlights through the plugin host's highlight API, which leaves the DOM and native undo untouched. A thread pane lists marks for the open page, shows each thread, and takes replies. Clicking a highlight opens its thread.

Lifecycle. A mark is open, accepted, rejected, or flagged for review. Accepting an addition, deletion or substitution applies it through the host's replace API, which runs native undo and the save pipeline and refuses if the quoted text has gone stale; the resulting commit carries the accepter's identity. Comments and highlights close by resolution, not application. Every transition is recorded on the mark with author and date.

Librarian suggestions on the author's pages. The librarian watches edits: it subscribes to the host's chapter-saved event, reduces each save to its changed regions, extracts the pages and terms those regions mention, and posts comments where it finds a forgotten reference or a continuity conflict. This is hoard's companion watcher (delta, extract, note, suppress, watch) driven by events instead of file polling. Suppression state carries over so the author can silence a kind of finding for a page. The librarian never edits the author's prose directly; it proposes.

Author suggestions on librarian-owned pages. Pages the librarian authored (lore, wiki) open in a suggest mode by default: the author's edits are recorded as marks instead of applied, and rendered as highlights. The librarian reviews each mark with the author and either accepts it (applying and committing under its identity) or flags it, with a comment saying why. If the author edits such a page directly, which stays possible, Git blame shows the paragraph passing to the author, and the librarian reports it as adoption by edit, as hoard's `spans.py` does today, rather than treating it as a conflict.

Requirements this places on the plugin host. The chapter-saved event must identify the chapter and carry enough to compute the change (a content hash and access to the previous text, or the diff itself). Highlights must be nameable per mark kind and per state so stale and open marks look different. The pane API must support a list with threads and reply input. The replace API must take the expected text and refuse stale applications. These are already among the nine primitives in the architecture assessment; this section fixes their payloads.

## Hoard tools to carry over

Sizes are Python lines from the sizing file. They port with their tests as the specification of behaviour.

- Port: lint 917, frontmatter 388, quotes 389, links, relink and dangling 719, marks 324, manifest 263, canon 1,357, companion 740. About 5,100 lines.
- Carry the rules, not the code: ownership, baseline, guard and spans (4,245), of which the enforcement rules and adoption detection survive and the vault-transition phases do not.
- Redesign: ripple (5,622), as an in-app workflow on Git history with its rulings log kept.
- Later release: the hoard-table convention (1,892).
- Not needed in Neo: transcription, media mover, sync canary and spikes (1,161).

## Not in the first release

Automatic-merge sync between devices, the hoard-table convention, Google Drive through its API rather than a synced folder, and any editing of the hoard vault in place.

## Open decisions

None at the specification level as of 10 October 2026. Decisions inside the phase plans are recorded in each plan's closing table.
