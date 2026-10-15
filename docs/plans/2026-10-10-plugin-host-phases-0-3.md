# Plugin host, phases 0 to 3: implementation plan

> For agentic workers: REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

Goal: a fork of Neo, now on upstream 1.5.5, with a TypeScript tool chain, chapter writes proven under a kill, per-paragraph chapter history through git drivers that leave chapter files as upstream writes them, and a versioned plugin host that reads the book (API 1) and then edits and marks it through Neo's own undo and save path (API 2).

Architecture: upstream files stay plain JavaScript. New `plugins.js` (renderer) and `plugins-main.js` (main process) hold the host; app.js, main.js, preload.js and index.html gain one-line hooks. Our layer is TypeScript under `src/`, built by esbuild into `plugins/hoard/`, with JSON Schema as the one definition of data shapes.

Tech stack: Electron 43, Node 24, TypeScript (strict, `erasableSyntaxOnly`), esbuild 0.28.2, Ajv 8.20.0 standalone, json-schema-to-typescript, Playwright 1.63.0, `node:test`.

Spec: E:\Dev\neo-hoard\neo-hoard-architecture-2026-10-10.md (sections 1, 3, 5) and E:\Dev\neo-hoard\neo-hoard-review-2026-10-10.md ("Patterns"; "must be fixed in any design").

Paths are relative to E:\Dev\neo-hoard\neo-novel-editor (branch `main`, on upstream 1.5.5 at 6877943) unless they start with a drive letter. The plan was written on upstream 1.4.7 (3d32960), so the measurements below and their line numbers are of 1.4.7.

## Global constraints

- Commits touching app.js, main.js, preload.js, index.html, plugins.js or plugins-main.js are plain JavaScript, hoard-free, separable as upstream pull requests, and tested in upstream's style. They hold upstream files only; fork files follow in a separate commit.
- Our layer is TypeScript built by esbuild 0.28.2; `tsc --noEmit` strict with `erasableSyntaxOnly`.
- `schemas/` defines every IPC message, sidecar, manifest and API input. The generator writes committed, drift-checked types and compiles standalone Ajv validators at build time. Validate at IPC handlers, plugin API inputs and file reads, never on the typing path.
- No Python. No `new Function` or `eval` in a shipped script; the CSP stays `script-src 'self'; object-src 'none'`. `npm start` and packaging run the build.
- AGENTS.md rules hold: nothing interrupts the writer, the renderer never touches the filesystem, decoration stays out of chapter HTML, an unchanged chapter is never rewritten, a save failure is never swallowed.
- Errors keep their stack (review pattern 4). A definitive refusal is returned once, never retried (pattern 6).

## Measurements of upstream 1.4.7

app.js has 15,478 lines, 533 top-level functions, 89 top-level `let`s and 60 `execCommand` calls; main.js 2,987 lines and 55 IPC handlers.

| Area | Where | Finding |
| --- | --- | --- |
| Typing | app.js:2817-2830, :4059-4066, :10922-10933 | the chapter input handler and `syncChapter` set `chapterHTML[chId] = captureBody(body)` and call `scheduleChapterSave` (6 callers): 800 ms, then `persistChapter` |
| captureBody | app.js:4007-4013 | `innerHTML` minus engine spans and screen-only marks; no newlines. scripts/spans.test.js:34 pins this |
| persistChapter | app.js:10849-10882 | one chain per chapter; sends `expected` (:10860); a `{conflict}` becomes a twin chapter; `knowDisk` once landed (:10867); failure rolls `savedHTML` back. The 20 s flush writes where `chapterHTML !== savedHTML` (:10997) |
| Main write | main.js:690-716, :428-459, :735 | `chapter:write` refuses with `{conflict}` when `chapterDiverged`, else `writeFileDurable` (`.tmp`, fsync, rename, Windows retries); `aux:write` is durable |
| refreshFromDisk | app.js:11045-11270 | on focus, every 30 s, on visible; skips chapters being written (:11097); re-reads changed `mtime:size` stamps; adopts a chapter without unsaved edits (:11185-11204), else twins it; re-renders between captureCaret and restoreCaret (:11221-11226) |
| renderChapters | app.js:2563-2691 | empties `#chapters` (:2565), rebuilds bodies from `chapterHTML` (:2647); 17 callers; kills every DOM Range into a chapter |
| openBook | app.js:2472-2558 | reads every chapter (:2484), assigns `book` and `chapterHTML` (:2492-2495), then `renderChapters` (:2518) and `switchTab` (:2529-2531) |
| Shelf, export | app.js:11285-11298, :14843-14851 | `backToShelf` flushes (:11287), then `book = null`; a shelf export borrows `book` and `chapterHTML` under `shelfExport` |
| Caret | app.js:11312-11373 | captureCaret gives `{chId, pIdx, off, scroll}`: `pIdx` indexes `querySelectorAll('p')`, `off` counts UTF-16 units, range start only. restoreCaret restores a collapsed caret and scroll; `resumePosition` (:11378) puts it a third down |
| Undo | app.js:2819, :2903-2908 | Ctrl+Z is structural only while `breakRun > 0`; each input event resets it, so `insertText` stays on native undo. Find's replace (:11900) uses `snapshotStructure` instead |
| Input filters | app.js:5204-5206, :3007-3027 | vim normal mode cancels every `insertText`; inside a `p.ghost`, a `beforeinput` handler rewrites the whole ghost |
| switchTab | app.js:7774-7865; index.html:117-122 | upstream hides only its own panels (:7816-7821); the final `else` (:7836-7864) calls `readAux(bookId, name)` for any other name. Tabs are fixed in HTML |
| onMenu | app.js:15119-15220 | independent `if (msg.type === ...)` lines, no fallback |
| CSP, bridge | index.html:6, :148-150; preload.js:3-72 | `script-src 'self'; object-src 'none'`; 56 bridge members, synchronous values via `sendSync` (:65); six `selectionchange` listeners already (app.js:4073 and on) |
| Startup | main.js:2924-2926, :2963, :2966 | "the window is created first"; `createWindow` runs before `buildMenu` |
| Pocket | pocket/www/index.html:161-165 | runs the same app.js, without plugins.js |

The assessment's line numbers (8479036) are stale; the table gives the current ones.

## Upstream changes since 8479036 that affect the design

- Chapter and aux writes are atomic and durable (825ff24, 3b492ad). The conflict check came in 15d7322, its test (scripts/power-loss.test.js:159) in 6e3ae3d. `aux:write` has round-trip tests (scripts/filesystem.test.js:129-131), no interrupted-write test. Upstream proposal 1 is done; phase 1 keeps a kill test and spends red/green on the spike.
- Chapter writes must go through `persistChapter`; a plugin never calls `window.neo.writeChapter`.
- No extension mechanism exists. onMenu has no fallback; switchTab's fallback opens any name as an aux file.
- The Outline shows cards by default (app.js:8254), breaking the baseline spec's outline locator.
- Pocket ships app.js, so every hook does nothing without `window.NeoPlugins`.
- The release workflow runs `npx electron-builder` without a build (.github/workflows/build.yml:46, :122, :150).
- This checkout has `core.autocrlf=true` and no .gitattributes; app.js and main.js are CRLF in the working tree.

## Test runners

- `npm test` (upstream, `node --test "scripts/*.test.js"`, app.js slices or main.js in `vm`).
- `npm run test:plugins`, `test:plugin-edits` (upstream style, `electron scripts/<name>.e2e.js`): PR 2 and PR 3 tests with no new dependency. The window is shown, so animation frames run; every once-per-frame event is tested here.
- `npm run test:unit` (fork, `node --test "tests/unit/**/*.test.ts"`).
- `npm run test:e2e` (fork, Playwright, `tests/e2e/*.spec.mjs`, untyped because they drive app.js globals). Its hidden window (implementation tests\support\profile-windows.cjs:14) stalls `requestAnimationFrame`.
- `npm run check`: `gen:check`, `typecheck`, `lint`, `test`, `test:unit`. Upstream owns `scripts/`, the fork `tests/`.

## File structure

Upstream: `plugins.js`, `plugins-main.js`, hook lines, `scripts/fixtures/plugins/`, `scripts/` tests. Fork: `.gitattributes`, `schemas/`, `src/generated/` (committed), `src/sdk/neo-plugins.d.ts`, `src/hoard/` (a shell until the librarian), `src/package.json` and `tests/package.json` (`{"type": "module"}`), `tools/`, `tests/`, gitignored `plugins/hoard/`.

## Review focus

1. Late-Plugin-Missed-Book-Open: a plugin whose script arrives after a book opened still receives `book-open`. Task 2.2.
2. Book-Switch-Without-Shelf: `openBook` over an open book gives `book-close` for the old one before `book` changes. Task 2.2.
3. Normalised-Chapter-Rewrite-Loop: a compact twin or adopted chapter is not rewritten on every flush once lined. Task 1.2.
4. Replace-During-Composition: `replace` while an input method composes returns `busy` and changes nothing. Task 3.2.
5. Offsets-Across-Inline-Marks: places inside `<i>` or `span.ph-mark`, and astral characters, count UTF-16 units as captureCaret does. Tasks 3.1 to 3.3.

---

## Phase 0: base and tool chain (fork only)

Goal: the ported baseline spec passes on untouched upstream; `npm start` and packaging build the TypeScript layer; a schema-drift check fails on a mismatch.

### Task 0.1: port the baseline end-to-end spec

Files: create `tests/e2e/neo-baseline.spec.mjs`, `tests/support/{electron-profile.mjs, electron-main.cjs, profile-boundary.cjs, profile-windows.cjs}`, `playwright.config.mjs`; `package.json` (`test:e2e`: `playwright test`).

Changes from E:\Dev\neo-hoard\.worktrees\implementation\tests\e2e\neo-baseline.spec.mjs and tests\support\electron-profile.mjs:

- `launchProfile` drops `prepareDevelopmentLaunch` and the rcedit runtime copy; it calls `_electron.launch({args: ['tests/support/electron-main.cjs'], cwd: appRoot, env})` with node_modules' Electron and `NEO_TEST_PROFILE`, deleting `ELECTRON_RUN_AS_NODE`.
- Collection options, `NEO_HOARD_*` variables and the ProseMirror wait go. electron-main.cjs keeps profile redirection, `guardTestWrites`, dialog stubs, network and updater blocks, and refusing stubs for `shell.openExternal` and `shell.showItemInFolder`.
- The seeded library.json adds `outlineView: 'list'` (app.js:8254) and `hintShown: true` (:2552).
- Everything the spec calls still exists, for example `moveSelectionToDarlings` (app.js:7633), the export builders (:13396-14409), `#st-book` (:12853).
- package-lock.json:2210 resolves Electron 43.7.6: pin it exactly and replace the stale `allowScripts` entry `electron@33.4.11`.

- [ ] Step 1: write the four tests as ported, the config and `test:e2e`.
- [ ] Step 2: `npm run test:e2e`. Expected: FAIL, `playwright` is not recognised.
- [ ] Step 3: add `@playwright/test` 1.63.0 and the pinned Electron, `npm install`, add the support files.
- [ ] Step 4: same command. Expected: 4 passed.
- [ ] Step 5: refactor: one `seedLibrary(profile)` helper.
- [ ] Step 6: commit `test: port the Neo baseline end-to-end spec to 1.4.7`.

### Task 0.2: TypeScript build; `npm start` and packaging build

Files: create `tsconfig.json`; `src/package.json` and `tests/package.json`, each `{"type": "module"}`, so `nodenext` treats `.ts` as ES modules and `verbatimModuleSyntax` accepts their imports; `tools/{build.mjs, targets.mjs, before-build.cjs}`, `src/sdk/neo-plugins.d.ts`, `src/hoard/{plugin.json, renderer.ts, main.ts}`, `tests/unit/build.test.ts`; modify `package.json` (`start`, `test:e2e`, `build.beforeBuild`), `.gitignore` (`/plugins/hoard/`).

Interfaces: `node tools/build.mjs [--out <dir>]` writes `<out>/hoard/renderer.js` (IIFE), `main.cjs` (CommonJS, `electron` external) and `plugin.json`; default `<out>` is `plugins/`; each target logs `{event: 'build.target', name, ms, bytes}`. `tools/before-build.cjs` is electron-builder's `beforeBuild` hook: it runs the build and returns `undefined`. tsconfig: `strict`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `nodenext`, `es2024`.

- [ ] Step 1: tests in `tests/unit/build.test.ts`: `start builds first` (`start` is `node tools/build.mjs && electron .`, `test:e2e` is `npm run build && playwright test`); `packaging builds first` (`build.beforeBuild` is `tools/before-build.cjs`, and calling it produces `plugins/hoard/renderer.js`, so CI's bare `npx electron-builder` ships the plugin); `clean build` (`--out <tmp>` writes all three); `CSP` (no `/new Function|\beval\(/` in either bundle); `packaging includes the output` (`build.files` keeps `plugins/**`, excludes `src/**`, `tools/**`, `tests/**`, `schemas/**`); `no direct bridge calls` (nothing under `src/` contains `window.neo.`).
- [ ] Step 2: `node --test tests/unit/build.test.ts`. Expected: FAIL, `tools/build.mjs` not found.
- [ ] Step 3: implement; add esbuild 0.28.2 and typescript (exact, 5.8 or later), scripts `build`, `typecheck`, `test:unit`, `check`. `renderer.ts` registers `{id: 'hoard', apiVersion: 1, activate() {}}`; `main.ts` exports an empty `activate(host)`.
- [ ] Step 4: same, then `npm run typecheck`. Expected: PASS, no TS1286.
- [ ] Step 5: refactor: targets as data in `tools/targets.mjs`.
- [ ] Step 6: commit `build: compile the TypeScript layer with esbuild; npm start and packaging build first`.

### Task 0.3: schemas, generated types, standalone validators, drift check

Files: create `.gitattributes` (`src/generated/** text eol=lf`, `schemas/** text eol=lf`, `tests/fixtures/** text eol=lf`), `schemas/plugin-manifest-v1.json`, `tools/gen.mjs`, `src/generated/{plugin-manifest-v1.d.ts, validators.cjs, validators.d.cts}`, `tests/fixtures/manifests/{valid,invalid}/`, `tests/unit/contracts.test.ts`; modify `tools/build.mjs` (generate first, validate `src/hoard/plugin.json`), `package.json` (ajv 8.20.0, json-schema-to-typescript exact; `gen`, `gen:check`).

Manifest v1: `id` `^[a-z][a-z0-9-]{1,31}$`; `apiVersion` integer 1 to 2; required `renderer`, optional `main` and `style`, each a file name `^[A-Za-z0-9_][A-Za-z0-9._-]*\.(js|cjs|css)$`; at most 16 `commands` `{id, title}` (title 1 to 64 characters); nothing else.

Interfaces: `validators.cjs` default-exports one `validate<Name>` per schema, here `validatePluginManifestV1(data): boolean` with `.errors`; type `PluginManifestV1`. Output is LF.

- [ ] Step 1: tests: `generated files match` (`node tools/gen.mjs --check` exits 0); `drift is caught` (a property added to a temp copy of the schema makes `--check --root <tmp>` exit 1 naming `plugin-manifest-v1.d.ts`); `line endings fixed` (`git check-attr eol src/generated/validators.cjs` reports `lf`); `fixtures` (`valid/` pass; `invalid/` fail: bad id, `../x.js`, apiVersion 0, extra key, 17 commands); `CSP` (no `new Function` or `eval(`).
- [ ] Step 2: `node --test tests/unit/contracts.test.ts`. Expected: FAIL, `tools/gen.mjs` not found.
- [ ] Step 3: implement `tools/gen.mjs [--check] [--root <dir>]`: json-schema-to-typescript per schema; Ajv (`strict`, `allErrors`, `code: {source: true}`) standalone CommonJS with a generated `.d.cts`; byte-stable output; `--check` prints each differing file.
- [ ] Step 4: same. Expected: PASS.
- [ ] Step 5: refactor: one schema walk shared by `gen` and `build`.
- [ ] Step 6: commit `build: JSON Schema defines the contracts; generate types and standalone validators, with a drift check`.

## Phase 1: durable writes and chapter history by textconv

Goal: prove a killed save leaves the old or the new file, and give chapters per-paragraph history in git while their files stay as upstream writes them.

### Task 1.1: kill test for chapter and aux writes (characterisation)

Upstream already writes through `writeFileDurable` (main.js:699, :735), so the main tests pass at once; the negative control proves they can fail. No production change.

Files: create `tests/support/main-loader.cjs` (the vm loader of scripts/power-loss.test.js:20-56, exported), `tests/support/write-forever.cjs`, `tests/unit/write-kill.test.ts`.

Interfaces: `write-forever.cjs <dir> <chapter|aux> [--in-place]` loads main.js through the loader, prints `writing`, then writes 4 MiB payloads A and B in turn. `--in-place` first replaces `writeFileDurable` in the vm context with `fs.writeFileSync`.

- [ ] Step 1: tests, 40 rounds each, `SIGKILL` 0 to 50 ms after the child's `writing` line: `chapter` (the file equals A or B; `chapters/` holds only it and at most its `.tmp`; a following write succeeds); `notes` (notes.html equals A or B; against the listing taken before, the book folder gains no file but notes.html.tmp); `the test can fail` (with `--in-place`, at least one round leaves neither A nor B).
- [ ] Step 2: `node --test tests/unit/write-kill.test.ts`. Expected: PASS. A failure of the first two is an upstream defect: stop and report it. A failing control means the test cannot see truncation: fix the test.
- [ ] Step 3: commit `test: a killed chapter or notes save leaves the old or the new file whole`.

### Task 1.2: chapter history by textconv (replaces the paragraph-per-line spike)

The spike first changed `persistChapter` to write one paragraph per line, and reported go for paragraph-level blame. On 2026-10-11 the owner chose Chapter-Format-Route textconv instead: "GitHub isn't necessary or suited for prose". The fork save patch, its tests and the lined snapshot changes were dropped (Drop-Fork-Save-Patch).

What holds now:
- Chapter files are byte-identical to upstream's (ba4c3e2, with a chapter-bytes spec that was red 7 of 7 before it).
- `tools/git/` holds a textconv driver that shows chapters one paragraph per line for diff, log and blame, and a merge driver for edits to different paragraphs (c223554). Chapter files are marked `-text`.
- `neo-compact.js` turns settled conflicts back into Neo's compact form.
- `setup-chapter-git.mjs` prints the git configuration by default and applies it only with `--apply` (1f51650). It has not been run; the Git-Remembers-Everything step runs it when history is turned on.
- The spec records the route (524b494).

## Phase 2: read-only plugin host and main half (upstream PR 2)

Goal: a fixture plugin adds a pane and a command and sees `chapter-saved` after typing; one that throws in `activate` leaves writing working. Each task is one commit of PR 2.

### Task 2.1: manifests, discovery and menu items

Files: create `plugins-main.js`, `scripts/fixtures/plugins/{probe,broken}/plugin.json`, `scripts/plugins-main.test.js`; modify `main.js` (a `require`; `plugins.wire({app, ipcMain, logError, appRoot: __dirname})`, registering `plugins:list`; menu items before Window at :2560), `preload.js` (`plugins: ipcRenderer.sendSync('plugins:list')`). Fork: `tests/unit/manifest-conformance.test.ts`.

Interfaces: `validManifest(m): boolean`; `discover()`, memoised and called by both `buildMenu` and `plugins:list`, returns manifests with `rendererUrl`, `styleUrl` and an absolute `mainPath`; `menuItems(send)` clicks send `{type: 'plugin-command', plugin, command}`. Roots are `plugins/` plus, only when `!app.isPackaged`, comma-separated `NEO_PLUGIN_DIRS`. URLs join path segments with `/`. Discovery refuses a root whose relative path `rel` is absolute (another drive), equals `..` or starts with `'..' + path.sep`, comparing case-insensitively on Windows, since `'self'` is tested only inside the app folder. Nothing runs at module load, so the `vm` loaders in `scripts/*.test.js` never discover.

- [ ] Step 1: tests in `scripts/plugins-main.test.js`: the probe is listed with `rendererUrl` `scripts/fixtures/plugins/probe/renderer.js` on every platform; a bad id, `../x.js`, apiVersion 0, a missing renderer, a duplicate id, a root on another drive or a root outside the app folder is skipped and logged with its folder; a root folder named `..x` inside the app folder is accepted; `NEO_PLUGIN_DIRS` is ignored when packaged; `discover` reads the folders once; `menuItems` gives a "Plugins" submenu whose "Say Hello" sends `{type: 'plugin-command', plugin: 'probe', command: 'hello'}`, and none without commands. Fork: `validManifest` and `validatePluginManifestV1` agree on `tests/fixtures/manifests/`.
- [ ] Step 2: `node --test scripts/plugins-main.test.js`. Expected: FAIL, `Cannot find module '../plugins-main.js'`.
- [ ] Step 3: implement.
- [ ] Step 4: same, plus `npm test`, `npm run test:unit`. Expected: PASS.
- [ ] Step 5: refactor: plugins-main.js imports nothing from Electron.
- [ ] Step 6: commit the upstream files as `Plugins: find bundled plugins and list their commands in a Plugins menu`, then the fork test as `test: the host's manifest check agrees with the schema`.

### Task 2.2: register, reads and events

Files: create `plugins.js`, `scripts/fixtures/plugins/{probe,broken}/renderer.js`, `scripts/plugins.e2e.js`; modify `index.html` (`<script src="plugins.js"></script>` before app.js at :150), `app.js` (hooks 1 to 7), `package.json` (`test:plugins`).

Interfaces: `NeoPlugins.register({id, apiVersion, activate})` accepts only a listed id with its manifest's `apiVersion`, which must be in `NeoPlugins.apiVersions` (`[1]`); otherwise it logs and never activates. If `activate(neo)` throws or rejects, the host removes the plugin's registrations and logs `plugin <id>: ` and the stack via `window.neo.logError`; no toast. `attach(get)` runs once at the end of app.js, then inserts each manifest's `<link>` and `<script>`; a plugin activated with a book open gets `book-open` at once. API 1 so far:

- `on(event, fn)` returns an unsubscribe. `book-open`, `book-close` `{bookId}`; `chapter-change` `{bookId, chId}` from typing and `syncChapter`, once per chapter per frame; `chapter-saved` `{bookId, chId}` after each landed write; `selection` `{place}` once per frame, `null` off the manuscript; `rendered` `{bookId}`, meaning any chapter may have changed (adoption at app.js:11185-11204, twins, structural edits). The host logs a throwing handler and runs the rest.
- `book()`: a `structuredClone`, `null` on the shelf and during a shelf export. `chapter(chId)`: copies `{id, html, paragraphs}`, or `null`.

App.js hooks, each behind `window.NeoPlugins`:

1. `openBook`, before :2492, when `book` is set and `shelfExport` is false (a shelf export can borrow `book` while openBook awaits its reads, app.js:14834-14845): `emit('book-close', {bookId: book.id})`.
2. `openBook`, after :2503, before `renderChapters`: `emit('book-open', {bookId})`.
3. `backToShelf`, after :11287, when `book` is set: `emit('book-close', {bookId: book.id})`.
4. `scheduleChapterSave`, after :10924: `emit('chapter-change', {bookId, chId})`.
5. `persistChapter`, after :10867: `emit('chapter-saved', {bookId, chId})`.
6. `renderChapters`, after :2690: `emit('rendered', {bookId: book.id})`.
7. Last line: `NeoPlugins.attach({book: () => (shelfExport ? null : book), chapterHTML: (id) => chapterHTML[id], currentTab: () => currentTab, switchTab, captureCaret, restoreCaret})`. Getters, because these `let`s are reassigned (app.js:2492, :2494, :11142, :11289).

- [ ] Step 1: tests in `scripts/plugins.e2e.js` (style of scripts/tabs.e2e.js, `NEO_PLUGIN_DIRS=scripts/fixtures/plugins`): `registers` (`window.__probe.activated`); `refusals` (an unlisted id and a wrong apiVersion are logged, never activated); `events` (open, type "Owl", wait 2 s: `book-open`, `rendered`, `chapter-change`, `chapter-saved` in that order, file holds "Owl"; "paragraph" selected in "One paragraph." gives `{pIdx: 0, off: 4, len: 9}`; the shelf gives `book-close`); `book switch` (`openBook(other)` gives `book-close` with the old id, then `book-open` with the new; an `openBook` that resumes while a shelf export holds `book` gives no `book-close`); `late activation` (a probe registered after `openBook` gets `book-open`); `coalescing` (20 inputs in a burst give at most 3 `chapter-change`, the last after the final input); `reads` (`book()` is a copy, `null` on the shelf and during `exportFromShelf`; `chapter(id).paragraphs` equals the page's texts); `broken plugin` (its `chapter-saved` listener, added before it threw, never runs; neo-errors.log holds `plugin broken:` and a stack line; `#hint` empty; typing and saving work); `CSP` (no `securitypolicyviolation`); in `scripts/plugins-main.test.js`, `hooks are guarded` (every `NeoPlugins.` in app.js sits behind `window.NeoPlugins`).
- [ ] Step 2: `npm run test:plugins`. Expected: FAIL at `registers`, `window.__probe` undefined: nothing loads the probe without plugins.js.
- [ ] Step 3: implement plugins.js and the hooks.
- [ ] Step 4: `npm run test:plugins`, `npm test`, `npm run test:tabs`, `npm run test:caret`, the baseline spec. Expected: PASS.
- [ ] Step 5: refactor: one `dispatch(listeners, detail)` that catches and logs.
- [ ] Step 6: commit `Plugins: a read-only plugin host with events and book and chapter reads`.

### Task 2.3: panes

Files: modify `plugins.js` (`addPane`, `showTab`), `app.js` (switchTab, after :7821), `scripts/fixtures/plugins/probe/renderer.js`, `scripts/plugins.e2e.js`.

Interfaces: `addPane({id, title})` adds tab `plugin:<plugin>:<id>`, wires its click to `switchTab`, and returns `{element}` inside `#aux-paper`. `showTab(name): boolean` hides every plugin pane on every call; for its own pane it shows it, sets `#aux-title` and returns `true`. Hook in switchTab after :7821, ahead of the darlings, outline and aux branches: `if (window.NeoPlugins && NeoPlugins.showTab(name)) { returnTo(); findHere(); return; }`.

- [ ] Step 1: test `pane` in `scripts/plugins.e2e.js`: the probe's tab shows its element and title with `#aux-editor` hidden, and no `plugin*.html` appears in the book folder; Notes then hides the pane and shows the Notes title and text; Manuscript hides it too.
- [ ] Step 2: `npm run test:plugins`. Expected: FAIL, the probe logs `neo.addPane is not a function`.
- [ ] Step 3: implement.
- [ ] Step 4: `npm run test:plugins`, `npm run test:tabs`. Expected: PASS.
- [ ] Step 5: refactor: panes join the per-plugin registry that disposal clears, so a failed plugin leaves no tab.
- [ ] Step 6: commit `Plugins: panes as tabs beside Notes, Outline and Darlings`.

### Task 2.4: commands

Files: modify `plugins.js` (`addCommand`, `runCommand`), `app.js` (onMenu, after :15123), `scripts/fixtures/plugins/probe/renderer.js`, `scripts/plugins.e2e.js`.

Interfaces: `addCommand(commandId, run)` throws `TypeError` for an id the manifest does not declare or one already bound; `runCommand(plugin, command)` calls it and logs a throw. Hook in onMenu after :15123: `if (msg.type === 'plugin-command') { if (window.NeoPlugins) NeoPlugins.runCommand(msg.plugin, msg.command); return; }`.

- [ ] Step 1: tests in `scripts/plugins.e2e.js`: `command` (a `plugin-command` message runs the handler once); `undeclared` (`addCommand('nope', f)` throws `TypeError`); `already bound` (a second `addCommand('hello', g)` throws `TypeError`, and the menu still runs the first handler); `throwing command` (logged, writing unaffected).
- [ ] Step 2: `npm run test:plugins`. Expected: FAIL, `neo.addCommand is not a function`.
- [ ] Step 3: implement.
- [ ] Step 4: same. Expected: PASS.
- [ ] Step 5: refactor: commands join the per-plugin registry that disposal clears.
- [ ] Step 6: commit `Plugins: commands from the Plugins menu`.

### Task 2.5: status

Files: modify `plugins.js` (`status`), `scripts/fixtures/plugins/probe/renderer.js`, `scripts/plugins.e2e.js`.

Interfaces: `status(text)` fills one `textContent` slot per plugin in `#counters`; `''` hides it; disposal removes it.

- [ ] Step 1: test `status` in `scripts/plugins.e2e.js`: "Indexed" shows in the probe's slot; `status('')` hides it; a failed plugin leaves no slot.
- [ ] Step 2: `npm run test:plugins`. Expected: FAIL, `neo.status is not a function`.
- [ ] Step 3: implement.
- [ ] Step 4: same. Expected: PASS.
- [ ] Step 5: refactor: status slots join the per-plugin registry that disposal clears.
- [ ] Step 6: commit `Plugins: a quiet status slot`.

### Task 2.6: a plugin's main-process half

Files: modify `plugins-main.js`; `main.js` (after `createWindow()` at :2963, in its own try/catch: `plugins.activateMains()`; an `afterWrite` call in `book:writeMeta` :652, `chapter:write` :699, `aux:write` :735, `json:write` :753); `preload.js` (`pluginInvoke`); `plugins.js` (`neo.invoke`); `scripts/fixtures/plugins/probe/main.js`. Fork: `schemas/ipc/hoard-ping-v1.json`, `src/hoard/{main.ts, renderer.ts}`, `tests/e2e/hoard-plugin.spec.mjs`.

Interfaces: a main entry exports `activate(host)`; `host` is `{id, handle(channel, fn), settings: {get(), set(obj)}, paths: {library(), userData, plugin}, log(level, message, data), onAfterWrite(fn)}`. `activateMains` starts each `activate` without awaiting it and keeps a per-plugin ready promise. `ipcMain.handle('plugin:invoke', (e, id, channel, payload))` waits on that promise, then routes; channels match `^[a-z][a-z0-9.-]{0,63}$`. `neo.invoke(channel, payload)` binds the caller's id and belongs to API 1. Settings sit under `plugins[id]` in settings.json. After-write events `{kind: 'chapter' | 'aux' | 'json' | 'meta', bookId, name}` go out on `setImmediate`.

- [ ] Step 1: tests in `scripts/plugins-main.test.js`: `('probe', 'echo', {a: 1})` resolves `{a: 1}`, also when sent before a slow `activate` ends; `createWindow` runs before any `activate`; `('other', 'echo')` rejects naming the channel; a handler error rejects and is logged with its stack; `settings.set` keeps other keys; `chapter:write` returns before the after-write listener runs, and a throwing listener does not fail the write; a main entry throwing in `activate` is logged and the next still loads. Fork: `neo.invoke('ping', {n: 1})` resolves `{n: 1}`; `{n: 'x'}` rejects with Ajv path `/n`; no CSP violation.
- [ ] Step 2: `node --test scripts/plugins-main.test.js`, `npm run test:e2e -- hoard-plugin`. Expected: FAIL, no `plugin:invoke` handler.
- [ ] Step 3: implement; `src/hoard/main.ts` answers `ping` after `validateHoardPingV1`.
- [ ] Step 4: same, plus `npm test`. Expected: PASS.
- [ ] Step 5: refactor: events and after-write share `dispatch`.
- [ ] Step 6: commit the upstream files as `Plugins: a main-process half with its own IPC, settings, paths, log and after-write events`, then the fork files as `hoard: health check through the plugin main half`.

## Phase 3: where, go, replace and highlight (upstream PR 3, API 2)

Goal: replace, then Ctrl+Z restores; a stale expectation is refused; highlights survive re-render; going back restores caret and scroll.

`NeoPlugins.apiVersions` becomes `[1, 2]`; API 1 plugins do not see the new calls. A place is `{chId, pIdx, off, len, scroll?}`, counted as captureCaret counts (UTF-16 units across inline elements), `len >= 0`, inside one paragraph.

### Task 3.1: where and go

Files: modify `plugins.js`, the probe (apiVersion 2); create `scripts/fixtures/plugins/old-api/`, `scripts/plugin-edits.e2e.js`, `test:plugin-edits`. Fork: `schemas/{place-v1, highlight-v1}.json`, `tests/fixtures/places/`, `tests/unit/place-conformance.test.ts` (plugins.js in `vm`; `NeoPlugins.validPlace` agrees with `validatePlaceV1`).

Interfaces: `where(): Place | null`; `len` is the selected length when the selection starts and ends in one paragraph, else 0. `go(place): boolean` switches to the manuscript, selects `off` to `off + len`, restores `scroll` if given, else puts the caret a third down as `resumePosition` does; `false`, with nothing moved, when the chapter or paragraph is missing.

- [ ] Step 1: tests in `scripts/plugin-edits.e2e.js`: `place round trip` (caret at chapter 2, paragraph 3, offset 5: `where()` deep-equals `{chId, pIdx: 2, off: 5, len: 0, scroll}`; `go` elsewhere, then `go(back)` restores selection and `scrollTop`); `selection length` (`off: 4, len: 9` for "paragraph" in "One paragraph."; `len: 0` across paragraphs); `astral offsets` (Review focus 5: in `<p>A😀é <i>x</i>y</p>` the caret after "y" has `off: 7`); `missing place` (`go({chId: 'nope', pIdx: 0, off: 0, len: 0})` is `false`, caret unchanged; from Notes, `go` lands on the manuscript); `old API` (old-api's `neo.where` is `undefined`).
- [ ] Step 2: `npm run test:plugin-edits`. Expected: FAIL, `neo.where is not a function`.
- [ ] Step 3: implement; `where` reuses the selection-event code of task 2.2.
- [ ] Step 4: same, plus `npm test`, `test:plugins`, `test:unit`. Expected: PASS.
- [ ] Step 5: refactor: one `rangeOfPlace(place): Range | null` for go, replace and highlight.
- [ ] Step 6: commit the upstream files as `Plugins: where and go, in the place shape the caret already uses`, then the fork files as `test: the host's place check agrees with the schema`.

### Task 3.2: replace

Interfaces: `replace(place, expectedText, newText): Promise<{ok: true} | {ok: false, reason: 'busy' | 'hidden' | 'missing' | 'stale' | 'blocked'}>`; `TypeError` when `expectedText.length !== place.len` or `newText` holds `\n` or `\r`. Checks before editing, in order: `busy` during a composition (the host tracks `compositionstart`/`compositionend`), `hidden` off the manuscript, `missing` paragraph, `blocked` inside a `p.ghost` (app.js:3007-3027), `stale` text. Then keep the writer's selection and scroll, select the range, run `document.execCommand('insertText', false, newText)` and compare the paragraph's text with the expected result. Unchanged text (vim normal mode cancels the insert, app.js:5204-5206) returns `blocked`; any other mismatch runs `document.execCommand('undo')` once, logs both texts and returns `blocked`. On success the writer's caret returns, shifted by the length change if later in the same paragraph, and the input event runs Neo's save path (app.js:2817). A refusal is final; nothing queues or retries it.

- [ ] Step 1: tests in `scripts/plugin-edits.e2e.js`: `replace saves` (`replace(p, 'paragraph', 'passage')` gives `{ok: true}`; page, `chapter-saved` and file follow); `undo restores` (Ctrl+Z via `sendInputEvent` brings back "One paragraph.", and the next save writes it); `stale is refused once` (`replace(p, 'paragrap!', 'x')` gives `stale`, nothing changes, a second call the same, no write); `refusals` (`hidden` from Notes, `missing` for `pIdx: 99`, `blocked` in a ghost line and in vim normal mode, page unchanged each time); `caret kept` (a caret in another paragraph stays; one later in the same paragraph moves by -2); `composition` (Review focus 4: `busy` after a dispatched `compositionstart`, `ok` after `compositionend`); `inline marks` (Review focus 5: across an `<i>` boundary `textContent` is right and the file has no `style=` span); `bad input` (wrong `len` or a newline throws `TypeError`).
- [ ] Step 2: `npm run test:plugin-edits`. Expected: FAIL, `neo.replace is not a function`.
- [ ] Step 3: implement.
- [ ] Step 4: same, plus the suites of task 3.1. Expected: PASS.
- [ ] Step 5: refactor: selection save and restore becomes `withWriterCaret(fn)`.
- [ ] Step 6: commit `Plugins: replace text through the editor, so undo and saving work as they do for typing`.

### Task 3.3: highlight

Interfaces: `highlight(name, places): void`; `name` matches `^[a-z][a-z0-9-]{0,31}$`; registry key `plugin-<id>-<name>`; empty `places` clears. The host keeps the places, builds live `Range`s and rebuilds them on each `rendered`. A manifest `style` file, linked once, holds the `::highlight(...)` rules. Disposal clears the plugin's highlights.

- [ ] Step 1: tests in `scripts/plugin-edits.e2e.js`: `marks without writing` (`CSS.highlights.get('plugin-probe-claims')` holds one range reading "paragraph"; mtime unchanged after a flush); `survives re-render` (after `renderChapters()` the range is connected and reads "paragraph"); `clears` (an empty list removes it; disposal removes all the probe's entries); `inside a placeholder` (Review focus 5: a place spanning `span.ph-mark` text resolves to the text captureCaret counts).
- [ ] Step 2: `npm run test:plugin-edits`. Expected: FAIL, `neo.highlight is not a function`.
- [ ] Step 3: implement.
- [ ] Step 4: every suite: `npm test`, `test:plugins`, `test:plugin-edits`, `test:tabs`, `test:caret`, `check`, `test:e2e`. Expected: PASS.
- [ ] Step 5: refactor: re-apply through the host's own `rendered` listener, not a second hook.
- [ ] Step 6: commit `Plugins: highlight passages with the CSS Highlight API, outside the file and the undo history`.

## Open risks

- Insert-Text-Is-Deprecated: Chromium still supports `execCommand('insertText')`, and Neo calls `execCommand` 60 times, so a Chromium change would break far more than `replace`.
- Whitespace-Nodes-From-Lined-Files: closed by the textconv decision. Chapter files keep upstream's compact form, so no `\n` text nodes reach the editable body.
- Line-Endings-Under-Git: with `autocrlf=true`, a chapter checked out as CRLF and saved as LF is a whole-file diff; phase 4 needs `eol=lf` for chapters.
- No-Isolation-Between-Plugins: plugins share the page and can call `window.neo.writeChapter`, skipping `persistChapter`. Bundled code is trusted; task 0.2 guards our own code.
- CSP-Outside-App-Folder: `'self'` is tested only inside the app folder; plugins from userData need their own check.
- Upstream-Velocity: 429 upstream commits since 8479036. Each one-line hook is rebased on every pull.
- Playwright-Electron: experimental, and its hidden window stalls animation frames; the upstream-style scripts are the fallback.
- Pocket-Has-No-Plugins: Pocket runs app.js without plugins.js, so plugin features are absent on the phone.

## Decisions only the user can make

Fill Override in the review pane (`/review-pane` opens it), or reply with `Item: override` lines. A blank Override keeps the proposal once you have reviewed the table; a blank cell alone does not authorise the work. The textconv decision has since replaced the spike in task 1.2.

| Item | Proposed action | Override | Reason |
| --- | --- | --- | --- |
| Atomic-Writes-Proposal | Drop upstream proposal 1 and keep only the kill test of task 1.1 | | Upstream 1.4.7 already writes chapters and notes atomically, with its own tests. |
| Paragraph-Lines-Upstream-Or-Fork | Carry the paragraph-per-line change as a fork patch; decide on upstream after the spike | Superseded: Chapter-Format-Route textconv, 2026-10-11 | Every chapter's bytes change on its next save, and an older Neo writes the compact form back. |
| Main-Half-In-Which-Pull-Request | Ship task 2.6 as the last commit of PR 2 | | `invoke` then joins API 1 with no version change between pull requests. |
| Plugin-Commands-Menu-Placement | Add a top-level Plugins menu only when a plugin declares commands | | Neo's contribution rules resist new chrome, and an empty menu would be clutter. |
| Panes-Beside-The-Manuscript | Defer side panes to phase 6 and ship tab panes now | | Screens S7 and S8 need a pane beside the page, but nothing in phases 0 to 3 does. |
| Replace-Off-Manuscript | Refuse with `hidden` | | Switching tabs under the writer would move them without warning. |
| Ask-Hugh-First | Propose PR 2 as the first pitch once it is green; do not wait on a reply | | The author carries the hooks as a fork patch and proposes upstream in parallel. |
| Electron-Pin | Pin 43.7.6 | | Upstream's lockfile already resolves it. |
| Execution-Method | Use subagent-driven development | | Tasks depend on each other's interfaces, and the upstream commits must be ready for review. |

Evidence (not for review): line references are in "Measurements of upstream 1.4.7"; durable writes 825ff24 and 3b492ad, conflict check 15d7322, its test 6e3ae3d.
