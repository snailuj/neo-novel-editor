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
- Wiki pages are HTML in the library, edited in Neo with the same round trip as chapters. An Import-to-Wiki tool converts hoard or old-vault Markdown once at ingest. It takes a list of pages picked through the OS file picker, not a folder, because hoard keeps writing and non-writing pages in the same folders (any local folder, including synced Drive folders; no Drive API in the first release). Ingest appends each page to the manifest and emits a change event. Ripple reads those events later, so the import does not run ripple.
- No automatic-merge sync in the first release.
- Hoard's writing-project tools are rebuilt in TypeScript inside Neo-Hoard. Ripple is redesigned for in-app use on Git history rather than ported, keeping its rulings log and the rule it enforces. The hoard-table convention waits for a later release.
- Upstream is fetched at the start of each session, and the hook commits are rebased before each phase and each upstream proposal.
- Marks are made through the pane and selection commands, never typed as `{>> <<}` syntax inside Neo. Librarian-owned pages open in suggest mode by default, with an explicit switch to direct editing.
- If the plugin host is accepted upstream, other plugins may later share it; the host's namespaced ids and IPC allow for that, and nothing more is designed for it now.

## Chapter file format

Chapter-Format-Route = textconv (decided 11 October 2026, replacing the fork's paragraph-per-line save).

A chapter file is the compact HTML upstream Neo writes, byte for byte. The fork's save and load path matches upstream's apart from the double-save guard in `scheduleChapterSave` and the plugin host hooks, and `tests/e2e/chapter-bytes.spec.mjs` compares the saved bytes with upstream's own `captureBody` and `persistChapter`. Git is taught to show and merge the file one paragraph per line, locally, by a textconv driver and a merge driver in `tools/git/`.

The reason, in the author's words:

> GitHub is not needed or suited for prose, and local diff, log and blame per paragraph are enough.

How it works. `tools/git/neo-textconv.js` prints a chapter one paragraph per line, so `git diff`, `git log -p` and `git blame` follow paragraphs while the stored file is untouched. `tools/git/neo-merge.js` lines up the three versions of a chapter, merges them with `git merge-file`, and writes the result back compact. Edits to different paragraphs merge cleanly. Edits to the same or to adjacent paragraphs conflict, as git's line merge always does. A file with whitespace between its top-level blocks is not what Neo writes, so the driver merges the raw files rather than drop that whitespace.

Setting it up, once per machine:

1. `node tools/git/setup-chapter-git.mjs` prints the commands and the attribute line and changes nothing. `node tools/git/setup-chapter-git.mjs --apply --global` sets `diff.neochapter.textconv`, `diff.neochapter.cachetextconv`, `merge.neochapter.name` and `merge.neochapter.driver` in the global git config. `--apply --repo <path>` sets them in one repo's own config instead. Git keeps driver commands in config only, never in a repo, so each machine needs this. The script paths are absolute and quoted, because the library folder is usually `NEO Library`, and a path relative to the repo is missing when git checks out the first chapter.
2. Put this line in the library repo's `.gitattributes`: `book-*/chapters/*.html diff=neochapter merge=neochapter -text`. It covers every book's chapters. `-text` is needed: with `core.autocrlf` on, git turns a newline inside a chapter (in a `pre` block, say) into CRLF on checkout, and the stored file is then no longer the one Neo wrote.
3. Node must be on the PATH of the shell git uses. `cachetextconv` keeps converted text as a note under `refs/notes/textconv/neochapter` in each clone, which makes the second `git blame` of a chapter fast (about 0.1 s against 3 s for 30 revisions) and needs `user.name` and `user.email` to be set, as for any commit.

Limits:

- GitHub's web view, and any hosted review, runs no textconv. It shows one line per chapter.
- A clone without the setting shows whole-chapter diffs and one-line blame. The stored files and history are the same as with the setting, so nothing is lost.
- The merge driver needs its own config entry on each machine. A clone without it conflicts on any two edits to one chapter.
- A chapter with a merge conflict holds the lined text with conflict markers, so the writer can settle it. Once settled, the file is still lined, and upstream Neo loads the line breaks between paragraphs as text nodes. `node tools/git/neo-compact.js <library folder>` makes it compact again with `compactLines` from `tools/git/neo-lines.js`: it lists the chapters it would change, `--write` rewrites them in place (through a temp file and a rename), and it refuses a file that still holds conflict markers or would not line back to what it was. Close Neo, or the book, before running it with `--write`, because a save made between the tool's read and its rename would be lost.
- Libraries last saved by an earlier build of this fork hold lined chapters, which load the same way until `neo-compact.js` has converted them.

## Library history

Built 15 October 2026 (roadmap step 2, Git-Remembers-Everything); the plan is `port-plan/plans/git-remembers-everything.md` in the project files. It lives in the hoard plugin's main half, under `src/hoard/git/`, and changes no upstream file.

- The library's history is kept only when the library folder is the top of its own git repository. A library with none waits for Plugins > Keep Library History, which runs `git init`, adds any missing lines to `.gitignore` and `.gitattributes`, and commits what is there; running it again changes nothing. A library inside a bigger repository, or a machine with no git, keeps no history and NEO works as usual.
- `.gitignore` leaves out `*.tmp`, `*.bak`, `.DS_Store`, `*.icloud`, `book-*/snapshots/` (upstream's snapshots are a second history of whole chapters), `Backups/`, `Exports/`, `neo-errors.log` and `_catalog.txt`. `.gitattributes` gets the chapter line above.
- A commit comes 60 s after the last landed write, and when the caret moves into another chapter or a book closes, once no write has landed for a second (at most five). Quitting makes one last commit within five seconds; what it misses, or a crash leaves, is committed at the next start as `recovered`. Commits run one at a time. Opening runs a fixed handful of git commands and never walks the log.
- Author commits take the identity from git config, with `user.useConfigOnly`, so a machine with none makes no commit rather than a guessed one. Librarian commits take `Librarian <librarian@neo-hoard.invalid>`. Both can be set in settings.json under `plugins.hoard.git` (`author`, `librarian`, `path` for the git binary, `idleSeconds`), checked by `schemas/hoard-settings-v1.json`. Each commit carries a `Neo-Checkpoint:` trailer naming why it was made.
- Every git call skips the repository's own hooks, never signs and never prompts. A failure keeps git's exit code and stderr, and the same failure is logged once, not on every pause.
- A book folder with a `.git` of its own (upstream PR #369's per-book version history) is left out of the library's commits and logged, because staging it would make an embedded repository and drop its words from the history.
- Blame is per paragraph on any machine: the plugin passes the chapter textconv and its attributes line on git's command line, and the build bundles the textconv as `plugins/hoard/textconv.cjs`, unpacked from the asar, run by Electron as node. `alignBlame` puts the lines against the window's paragraphs; one whose text has changed since the file was written is credited to no one. The Comments section shows who wrote the caret's paragraph.
- A librarian edit sits between two commits (step 7; `src/hoard/git/librarian.ts` in the window, `src/hoard/git/pair.ts` and `GitLayer.around` in the main half). The window holds the chapter (host API 3 `hold`), and the main half waits until the chapter on disk is what the window holds, so the writer's last save is in, then commits everything pending as the author's (`librarian-before`). The edit runs through `replace`; the main half waits until the disk holds the edited chapter, then commits that chapter's file alone as the librarian's (`librarian-after`), so what the writer saved elsewhere meanwhile stays theirs. No checkpoint runs in between, pairs run one at a time, and the chapter is let go however the edit ends. A save that does not land within five seconds refuses the edit (`unsaved`) before anything changes; a failed author commit refuses it too; an edit that fails still has what it changed committed as the librarian's. An edit the window never ends is committed as the librarian's after a minute. With no history the edit runs alone.
- Not built yet: the validation gate before a commit (the static checks port). A library that Syncthing or iCloud Drive syncs is only warned about in the log.

## Comments as built

Built 15 October 2026 (roadmap step 3, Marks-Live-In-Sidecars); the plan is `port-plan/plans/marks-live-in-sidecars.md` in the project files. The window half is `src/hoard/marks/window.ts`, the main half `src/hoard/marks/store.ts`; the only upstream line is in the daily backup.

- A chapter's marks are in `.neo/<bookId>/chapters/<chId>.json`, checked by `schemas/hoard-marks-v1.json`. The schema holds all five kinds and every state; the window makes comments only, and resolves or reopens them. Stale is never stored.
- A mark keeps its exact quote, inside one paragraph, and up to 32 UTF-16 units of the chapter's text either side (paragraphs joined by a newline), the place it was made, and the library's HEAD then. It is found again by its quote; the context picks between copies, and the place it was made breaks a full tie. A quote that is gone leaves the mark stale: listed as "Not found", not drawn, and drawn again when the words come back.
- The window sends ids and words; the main half adds the time, who (always the author from the window) and the commit. Each action reads the file afresh and writes it whole, one at a time per file. A file that does not read is reported and never written over. Reading never writes, and each write tells the git layer, so the next commit takes the sidecar with the chapter.
- Highlights are named `comment`, `highlight`, `suggestion`, `flagged` and `active`. The Comments section beside the manuscript lists the marks of the chapter at the caret, with threads, replies and Resolve or Reopen, and names who last wrote the caret's paragraph, from blame. A caret move never opens it; Add Comment (Plugins menu, or its own button) does.
- The daily backup zip keeps `.neo` with the books.
- Not built yet: suggestions and their review (step 8), references in comments (step 5's wiki gives them pages), CriticMarkup at the Markdown boundaries, and marks across paragraphs (a host place lies in one paragraph). Sidecars stay where they are when a book is duplicated or a chapter goes to Darlings.

## Wiki as built

Built 15 October 2026 (roadmap step 5, Wiki-Moves-Into-Neo); the plan is `port-plan/plans/wiki-moves-into-neo.md` in the project files. The window half is `src/hoard/wiki/window.ts`, the main half `src/hoard/wiki/store.ts`; the host gained API 4's `open(bookId)` in `plugins.js`, with one function and one getter in `app.js`.

- The wiki is one NEO book, made by the first import as `book:create` makes a book and named in `.neo/wiki.json`. It is on no shelf, because only the window writes `library.json`: Plugins > Edit Wiki as a Book opens it, and File > Reshelve a Book puts it on a shelf. Each page is an `unnumbered` chapter titled with its file's name.
- The wiki is looked up in a pane beside the book being written (the author's direction of 15 October), so the writer keeps their place: a Wiki section of the right-hand pane (`src/hoard/wiki/pane.ts`) shows a page as saved, its links as buttons, with Back and Forward and Edit in Wiki Book. Editing in the pane with live preview, and suggest, accept, comment and resolve there, come later; until then pages are edited in the wiki book.
- Plugins > Import to Wiki… takes Markdown files from the OS file picker. A message box says what comes in and what does not, and why: already in the wiki, changed since it came in (never written over, as the page may hold newer words), a name already taken, or a file that does not read. Nothing is imported while the wiki is the open book, because the window writes its own copy of `book.json` whole.
- A page arrives as NEO's own HTML (the author's ruling of 15 October), so the wiki is edited, searched and cited like any book. NEO's chapters are paragraphs, and every place, mark, blame line and replace counts them, so each Markdown block becomes one `<p>` whose class names it, as a script's lines do: `wiki-h1` to `wiki-h6`; `wiki-li` with `data-depth`, `data-n` and `data-task`; `wiki-quote` with `data-depth`; `wiki-callout` with `data-callout`; `wiki-code` (one per line, with `data-lang`); `wiki-table` (a row as written, `data-head` on the header); and NEO's own `scene-break` for a rule. Each line with words on it is a block, as in Obsidian. Emphasis becomes NEO's `b`, `i` and `s` and code spans `code`, by CommonMark's rules for delimiter runs (`src/hoard/wiki/inline.ts`); `[[links]]` stay as typed, which is how a writer makes one in any book. The plugin's stylesheet draws bullets, numbers, ticks and quote bars, so they are never text.
- Every block carries `data-block`, the id a citation points at (`[[Page#^id]]`): the page's own Obsidian `^id` where it gives one, else six new hex digits. As with NEO's `data-sec-id`, the first paragraph holding an id owns it, since Enter copies the attribute onto the new paragraph.
- The frontmatter goes to `.neo/<bookId>/pages/<chId>.json` (`schemas/hoard-page-v1.json`) with the source path and its SHA-256.
- CriticMarkup becomes open marks in the chapter's marks sidecar, the page reading as if each were rejected: insertions, deletions, substitutions, highlights, and comments on a highlight or a suggestion. A mark that cannot be one here (a lone comment, an AI mark, one across lines) stays in the text as written, and the summary counts it. Insertions anchor at a point and are listed, not drawn, until step 8.
- Each page adds a `converted` line to `.neo/manifest.jsonl` and a `page-imported` line to `.neo/changes.jsonl` (`schemas/hoard-change-v1.json`) for ripple to read later. Writes go chapter files and sidecars first, `book.json` next, the manifest and change log last; the page sidecars, not the manifest, say what the wiki holds. With history kept, the import is two commits, so blame credits each paragraph to whoever owns it: first the author's (`import-author`), holding what they wrote meanwhile and each page with only its quotations and code, which hoard counts as the author's bytes; then the librarian's (`import`, `Pages imported to the wiki`), with the whole pages, their sidecars, the manifest and the change log.
- `[[links]]` are drawn in every book, `wiki-link` when the target names a page (by title, as Obsidian resolves it, never through an alias) and `wiki-missing` when it does not. Ctrl+click (Cmd+click) or Plugins > Follow Link shows the page in the Wiki pane from another book, and moves the caret to it in the wiki book. While the wiki is open its pages are set flush left without a drop cap.
- Not built yet: updating a page from a changed source, tables as tables, Markdown links and footnotes as anything but text, attachments and embeds, giving a new id to a paragraph that copied one, and writing pages into books.

## Search as built

Built 15 October 2026 (roadmap step 6, Librarian-Can-Search); the plan is `port-plan/plans/librarian-can-search.md` in the project files. The window half is `src/hoard/search/window.ts`; the main half's client is `client.ts`, and the worker `worker.ts` over `library.ts`.

- Plugins > Search Library… opens a Search section beside the book, with the focus in its field and the words selected on the page in it. A search runs once typing pauses, from two letters, over All Books (the default), the Wiki or This Book. Enter goes to the first result.
- The library's files are read in a utility process, as NEO's spellchecker is, started on the first search. It keeps each chapter's paragraphs (`paragraphTexts`, the window's own count) folded in memory and writes nothing, so no index sits in the library. Before each search it compares every chapter's mtime and size and reads again only what changed, which also catches a sync from another device. An iCloud placeholder is never read; it is counted and the pane says so.
- The open book is searched in the window, on its paragraphs as they stand, which can be ahead of its file. The worker leaves it out.
- Matching folds case, accents, curly quotes and runs of white space (`fold.ts`), and maps each match back to the words as written, so a result is a place. A phrase stays inside one paragraph. Titles that hold it come first.
- Results come in groups, the wiki first, then the open book, then the others by title, with a count; at most 200 are shown of up to 1,000 counted. A result in the open book selects its words. A wiki result shows its page in the Wiki section at the words, marked, and the writer stays where they were. A result in another book opens it at the words.
- The first search logs the worker's numbers (books, chapters, paragraphs, units held, files read, ms) at info, later ones at debug, so a slow library shows before a persistent index is built.
- Not built yet: tags, backlinks and frontmatter fields as kinds of search; Notes pages, the Outline, Darlings and snapshots; an index on disk.

## Librarian watcher as built

Built 16 October 2026 (roadmap step 7, Librarian-Watches-Edits, the half beside the commit pair); the plan is `port-plan/plans/librarian-watches-edits.md` in the project files. It is hoard's companion (delta, extract, note, suppress) under `src/hoard/companion/`, driven by `chapter-saved` instead of polling files.

- The window keeps each saved chapter of any book but the wiki as it was at its first save there and as last saved, and hands both to the main half at every save (the author's ruling of 16 October), one read per chapter at a time. While the writer is still in the chapter the caret goes along, and a name it is in or just after is left for a later read, since the word may not be finished. Leaving the chapter hands it over a last time without the caret.
- Show or Hide Comments (Ctrl+Shift+M, ⌘⇧M on a Mac, and the Plugins menu) keeps every mark off the page, a new one included, until shown again. It is kept per device, as NEO keeps how it looks. The Comments section still lists the marks and says they are hidden.
- A paragraph is new writing when its words, white space folded, were not in the chapter before, each copy counted (`delta.ts`): a moved or reformatted paragraph is not new.
- In those paragraphs a wiki page is found by its title or an alias from its frontmatter, as a whole phrase in any case, hyphens and spaces alike, three letters at least, the longest match winning (`mentions.ts`). A typed `[[link]]` and inline code are left out. A curly apostrophe matches a straight one and a no-break space a space, since NEO types both.
- Matching keeps each page's pattern while the wiki's pages stay the same: with 500 pages a read of one new paragraph takes under a millisecond once warm, and about 40 ms the first time.
- Each page found gets one librarian comment on its first mention, in hoard's words (`finding.ts`): "[[Kraken]]: matched as a bare name in your prose (a guess, not a link you typed)." A page whose frontmatter says `draft_status: pantsing` is "an offering from the pantsing shelf" first. No advice and no continuity.
- The chapter's own findings, open or resolved, are what it has been told about, so a page is flagged once per chapter. Nothing else is stored for that.
- Stop Flagging This Page (Plugins menu), on the librarian's comment at the caret or picked in the Comments section, resolves it and quiets its page in every book; Flag This Page Again undoes that. Quiet pages are kept in `.neo/companion.json` by the page's chapter id (`schemas/hoard-companion-v1.json`). A quiet file or a marks file that does not read is reported and never taken for empty or written over.
- A `[[link]]` in any comment's words is a button that shows its page in the Wiki section.
- Not built yet: continuity findings (hoard's canon lists candidate pairs only, for a person or a semantic reviewer); watching the wiki's own pages; a button for Stop Flagging on the comment's card (step 8's card actions); committing the librarian's comments under its own name (they ride the next checkpoint, each mark saying who made it, until the commit pair is in).

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
