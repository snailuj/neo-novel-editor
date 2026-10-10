import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';
import path from 'node:path';
import { access, readFile, stat, writeFile } from 'node:fs/promises';

// F: a chapter file kept one paragraph per line
const F_LINES = ['<p>First line.</p>', '<p>Second line.</p>', '<p>Third line.</p>'];
const F = F_LINES.join('\n') + '\n';
const CHAPTER = 'chapter-synthetic';

const chapterFile = (fixture, bookId, chId = CHAPTER) =>
  path.join(fixture.profile, 'documents', 'NEO Library', bookId, 'chapters', chId + '.html');

async function onDisk(file) {
  return { text: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs };
}

// flushAllSaves, then every chapter write it started, to the end. The pause
// first means a rewrite of the same bytes would still carry a later mtime.
const flush = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  flushAllSaves();
  await Promise.all(Object.values(chapterChain));
});

async function typeAtEndOf(page, index, text) {
  await page.locator('.chapter-body p').nth(index).click();
  await page.keyboard.press('End');
  if (text) await page.keyboard.insertText(text);
}

const everyParagraphStartsALine = (text) => expect(text).not.toMatch(/[^\n]<p[\s>]/);

// The line breaks a chapter file keeps between paragraphs never reach the
// page: these are the whitespace-only text nodes standing directly in the
// elements `selector` finds (every chapter body by default).
const blankChildren = (page, selector = '.chapter-body') => page.evaluate((sel) =>
  [...document.querySelectorAll(sel)].flatMap((el) => [...el.childNodes])
    .filter((n) => n.nodeType === Node.TEXT_NODE && !n.data.trim()).map((n) => n.data), selector);

test('untouched book writes nothing', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    const before = await onDisk(file);
    await flush(fixture.page);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(before);
    expect(before.text).toBe(F);
  } finally { await fixture.close(); }
});

test('an edit rewrites one line', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 1, ' Typed.');
    await flush(fixture.page);
    const { text } = await onDisk(chapterFile(fixture, bookId));
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(F_LINES[0]);
    expect(lines[1]).toContain('Typed.');
    expect(lines[2]).toBe(F_LINES[2]);
    everyParagraphStartsALine(text);
    expect(text.endsWith('\n')).toBe(true);
  } finally { await fixture.close(); }
});

test('Enter makes its own line', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 1, '');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('New line.');
    await flush(fixture.page);
    const { text } = await onDisk(chapterFile(fixture, bookId));
    expect(text.split('\n')).toEqual([F_LINES[0], F_LINES[1], '<p>New line.</p>', F_LINES[2], '']);
  } finally { await fixture.close(); }
});

test('reopen round trip', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    await typeAtEndOf(fixture.page, 1, ' Typed.');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('New line.');
    await flush(fixture.page);
    const saved = await onDisk(file);
    everyParagraphStartsALine(saved.text);
    await fixture.page.evaluate(async (id) => { await backToShelf(); await openBook(id); }, bookId);
    await flush(fixture.page);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(saved);
    // the page holds the file's text, without the line breaks between paragraphs
    expect(await fixture.page.evaluate(() => paragraphLines(captureBody(document.querySelector('.chapter-body'))))).toBe(saved.text);
  } finally { await fixture.close(); }
});

test('a lined chapter reopens with no line break between paragraphs on the page', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    await fixture.page.evaluate(async (id) => { await backToShelf(); await openBook(id); }, bookId);
    await expect(fixture.page.locator('.chapter-body p')).toHaveCount(3);
    expect(await blankChildren(fixture.page)).toEqual([]);
  } finally { await fixture.close(); }
});

test('own save is not news', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 1, ' Typed.');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('New line.');
    await flush(fixture.page);
    const read = () => fixture.page.evaluate(() => ({ order: [...book.chapterOrder], darlings: JSON.stringify(darlings) }));
    const before = await read();
    await fixture.page.evaluate(() => refreshFromDisk());
    expect(await read()).toEqual(before);
    expect(await fixture.page.locator('#hint').textContent()).not.toContain('Updated from your other device');
  } finally { await fixture.close(); }
});

test('outside edit is adopted', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    const theirs = [F_LINES[0], F_LINES[1], '<p>Third line, from the other device.</p>', ''].join('\n');
    await writeFile(file, theirs);
    await fixture.page.evaluate(() => refreshFromDisk());
    await expect(fixture.page.locator('.chapter-body p').nth(2)).toHaveText('Third line, from the other device.');
    const adopted = await onDisk(file);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(adopted);
    expect(adopted.text).toBe(theirs);
  } finally { await fixture.close(); }
});

test('no rewrite loop', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    // a compact chapter, as keepOtherDeviceVersion leaves it in chapterHTML
    const twinId = await fixture.page.evaluate(async (chId) => {
      await keepOtherDeviceVersion(book.id, chId, '<p>Other one.</p><p>Other two.</p>');
      return book.chapterOrder[book.chapterOrder.indexOf(chId) + 1];
    }, CHAPTER);
    const file = chapterFile(fixture, bookId, twinId);
    const written = await onDisk(file);
    expect(written.text).toBe('<p>Other one.</p>\n<p>Other two.</p>\n');
    await flush(fixture.page);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(written);
  } finally { await fixture.close(); }
});

// deleteChapterQuiet leaves savedHTML as it was, so a save that skipped text
// equal to savedHTML would leave the undone chapter without a file
test('undo of a quiet chapter delete writes the file back', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    await fixture.page.evaluate(async (chId) => {
      createChapterAt(book.chapterOrder.length); // the book keeps a chapter
      await Promise.all(Object.values(chapterChain));
      snapshotStructure('chapter delete');
      await deleteChapterQuiet(chId);
    }, CHAPTER);
    await expect(access(file)).rejects.toThrow();
    await fixture.page.evaluate(() => structuralUndo());
    await flush(fixture.page);
    expect(await fixture.page.evaluate(() => book.chapterOrder)).toContain(CHAPTER);
    expect((await onDisk(file)).text).toBe(F);
  } finally { await fixture.close(); }
});

// Enter twice makes a section break and a third splits the chapter. The
// split's undo saves the chapter, which lines the page's copy, while the
// break's undo still holds the copy as typed: the two differ only in line
// breaks, so the second undo must not take the chapter for one changed since.
test('undoing a break and a split sends nothing to Darlings', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 2, '');
    for (let i = 0; i < 3; i++) await fixture.page.keyboard.press('Enter');
    expect(await fixture.page.evaluate(() => [book.chapterOrder.length, undoStack.length])).toEqual([2, 2]);
    for (const left of [1, 0]) {
      await fixture.page.keyboard.press('Control+z');
      await expect.poll(() => fixture.page.evaluate(() => undoStack.length)).toBe(left);
    }
    await fixture.page.evaluate(() => Promise.all(Object.values(chapterChain)));
    expect(await fixture.page.evaluate(() => ({ order: book.chapterOrder, darlings }))).toEqual({ order: [CHAPTER], darlings: [] });
  } finally { await fixture.close(); }
});

// The page holds no line break nodes, so after a save a capture of the page
// with nothing typed (the one moveSelectionToDarlings makes) gives
// chapterHTML the compact form of the text the file holds lined. That is
// not an edit: the flush leaves the file alone, and a change from another
// device is adopted, not twinned.
test('a capture with nothing typed is not an edit', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    await typeAtEndOf(fixture.page, 1, '');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('New line.');
    await expect.poll(async () => (await onDisk(file)).text).toContain('<p>New line.</p>');
    await fixture.page.evaluate(() => Promise.all(Object.values(chapterChain)));
    const saved = await onDisk(file);
    expect(saved.text.split('\n')).toEqual([F_LINES[0], F_LINES[1], '<p>New line.</p>', F_LINES[2], '']);
    const compact = await fixture.page.evaluate((chId) => {
      chapterHTML[chId] = captureBody(document.querySelector(`.chapter[data-id="${chId}"] .chapter-body`));
      wordCache[chId] = null;
      return chapterHTML[chId] !== savedHTML[chId];
    }, CHAPTER);
    expect(compact).toBe(true);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(saved);
    const theirs = [F_LINES[0], F_LINES[1], '<p>New line.</p>', '<p>Third line, from the other device.</p>', ''].join('\n');
    await writeFile(file, theirs);
    await fixture.page.evaluate(() => refreshFromDisk());
    await expect(fixture.page.locator('.chapter-body p').nth(3)).toHaveText('Third line, from the other device.');
    expect(await fixture.page.evaluate(() => book.chapterOrder)).toEqual([CHAPTER]);
    await expect(fixture.page.locator('.chapter')).toHaveCount(1);
  } finally { await fixture.close(); }
});

// Nor is it a change to a snapshot (SNAPSHOTS in app.js): ⌘S after it finds
// nothing new, and the book as the snapshot had it is the same as now. The
// snapshot's page, like the book's, holds no line break between paragraphs.
test('a capture with nothing typed is no change to a snapshot', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, F);
    const seen = await fixture.page.evaluate(async (chId) => {
      const first = await takeSnapshot('k');
      chapterHTML[chId] = captureBody(document.querySelector(`.chapter[data-id="${chId}"] .chapter-body`));
      const compact = chapterHTML[chId] !== savedHTML[chId];
      const again = await takeSnapshot('k');
      switchTab('darlings');
      await showSnapshot(first.snap.name);
      return { compact, same: again.same, differ: snapShown.diff.length };
    }, CHAPTER);
    expect(seen).toEqual({ compact: true, same: true, differ: 0 });
    await expect(fixture.page.locator('#snap-view .snap-body p')).toHaveCount(3);
    expect(await blankChildren(fixture.page, '#snap-view .chapter-body')).toEqual([]);
  } finally { await fixture.close(); }
});

// A ghost is an outline section note shown in gray on the page, and typing
// on it replaces it. ghostAtCaret finds it from a caret on the body itself,
// between paragraphs (a click in the margin, the arrow keys), by the child
// node beside the caret. The line break a lined file keeps between the ***
// and the ghost stays off the page, so that child is the ghost in both forms.
for (const [form, gap] of [['compact', ''], ['lined', '\n']]) {
  test(`typing at a caret on the body before a ghost writes over it, ${form}`, async () => {
    const fixture = await launchProfile();
    try {
      const note = 'A note on what happens next.';
      await seedBook(fixture.page, ['<p>First line.</p>', '<p class="scene-break" data-sec-brk="s1">***</p>', `<p class="ghost" data-sec-id="s1">${note}</p>`].join(gap) + gap);
      const beside = await fixture.page.evaluate(({ chId, note }) => {
        book.sectionNotes = { [chId]: [{ id: 's1', text: note }] };
        const body = document.querySelector(`.chapter[data-id="${chId}"] .chapter-body`);
        body.focus();
        const at = [...body.childNodes].indexOf(body.querySelector('.scene-break')) + 1; // just after the ***
        window.getSelection().collapse(body, at);
        return body.childNodes[at].nodeType === Node.TEXT_NODE ? 'line break' : body.childNodes[at].className;
      }, { chId: CHAPTER, note });
      expect(beside).toBe('ghost');
      await fixture.page.keyboard.type('Word');
      expect(await fixture.page.evaluate((chId) => {
        const body = document.querySelector(`.chapter[data-id="${chId}"] .chapter-body`);
        const p = body.querySelector('[data-sec-id="s1"]');
        return {
          written: p.textContent,
          ghost: p.classList.contains('ghost'),
          brk: body.querySelector('.scene-break').textContent,
          loose: [...body.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.data.trim()).map((n) => n.data)
        };
      }, CHAPTER)).toEqual({ written: 'Word', ghost: false, brk: '***', loose: [] });
    } finally { await fixture.close(); }
  });
}

// A darling remembers its place by the text either side of the cut. Cut
// from the start of a paragraph, the text before it ends where the
// paragraph before ends; with a line break node there, the place fell
// inside that node and the words went back loose on the body, outside any
// paragraph.
test('a darling cut from the start of a paragraph goes back inside a paragraph', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, F);
    const back = await fixture.page.evaluate(async (chId) => {
      const body = document.querySelector(`.chapter[data-id="${chId}"] .chapter-body`);
      const words = body.querySelectorAll('p')[1].firstChild;
      body.focus();
      const cut = document.createRange();
      cut.setStart(words, 0);
      cut.setEnd(words, 'Second '.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(cut);
      // what darlingFromKeyboard (Ctrl+Shift+D) does, awaited
      const holder = document.createElement('div');
      holder.appendChild(cut.cloneContents());
      await moveSelectionToDarlings(holder.innerHTML, sel.toString());
      const cutAway = !body.textContent.includes('Second');
      await restoreDarling(darlings[0].id);
      return {
        cutAway,
        darlings: darlings.length,
        loose: [...body.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.data.trim()).map((n) => n.data),
        inParagraph: [...body.querySelectorAll('p')].some((p) => p.textContent.includes('Second'))
      };
    }, CHAPTER);
    expect(back).toEqual({ cutAway: true, darlings: 0, loose: [], inParagraph: true });
  } finally { await fixture.close(); }
});

// Darlings can hold a chapter's text as its file kept it: structural undo
// and a look at the disk keep the text they displace that way, with no
// place to go back to, and so does a loose card's chapter. It goes back
// onto the page without its line breaks, at the chapter's end or after the
// paragraph it came from.
test('a darling holding lined words goes back with no line break between paragraphs', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, F);
    const restore = (place) => fixture.page.evaluate(async ({ chId, place }) => {
      darlings.unshift({ id: 'd-lined-' + darlings.length, html: '<p>Kept one.</p>\n<p>Kept two.</p>\n', text: 'Kept one.\n\nKept two.', chapterId: chId, chapterLabel: 'Chapter 1', date: new Date().toISOString(), ...place });
      await restoreDarling(darlings[0].id);
    }, { chId: CHAPTER, place });
    await restore({}); // no place remembered: the end of its chapter
    expect(await blankChildren(fixture.page)).toEqual([]);
    await restore({ anchorPrefix: 'First line.', anchorSuffix: 'Second line.' });
    expect(await blankChildren(fixture.page)).toEqual([]);
    await expect(fixture.page.locator('.chapter-body p')).toHaveText(['First line.', 'Kept one.', 'Kept two.', 'Second line.', 'Third line.', 'Kept one.', 'Kept two.']);
  } finally { await fixture.close(); }
});

// A whole script pasted (more than 60 lines) goes in through spPasteMany.
// From a caret set on the body itself it takes the line at the caret's
// child offset and puts the paste below it. Line break nodes on the page
// made that offset count about twice as many children as there are lines,
// so the paste went in further down.
const SCRIPT = ['<p class="sp-heading">INT. ROOM - DAY</p>', '<p>One.</p>', '<p>Two.</p>', '<p>Three.</p>', '<p>Four.</p>', '<p>Five.</p>'];
for (const [form, gap] of [['compact', ''], ['lined', '\n']]) {
  test(`a script pasted at a caret on the body lands beside the caret, ${form}`, async () => {
    const fixture = await launchProfile();
    try {
      await seedBook(fixture.page, SCRIPT.join(gap) + gap, { format: 'screenplay' });
      const lines = await fixture.page.evaluate((chId) => {
        const body = document.querySelector(`.chapter[data-id="${chId}"] .chapter-body`);
        body.focus();
        window.getSelection().collapse(body, [...body.childNodes].indexOf(body.querySelectorAll('p')[3])); // just before "Three."
        // a script pasted as plain text, read as Fountain
        const pasted = ['EXT. FIELD - NIGHT'];
        for (let i = 1; i <= 60; i++) pasted.push(`Pasted ${i}.`);
        const clip = new DataTransfer();
        clip.setData('text/plain', pasted.join('\n\n'));
        body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clip, bubbles: true, cancelable: true }));
        return [...body.querySelectorAll('p')].map((p) => p.textContent);
      }, CHAPTER);
      expect(lines).toHaveLength(SCRIPT.length + 61);
      expect(lines.slice(0, 5)).toEqual(['INT. ROOM - DAY', 'One.', 'Two.', 'Three.', 'EXT. FIELD - NIGHT']);
      expect(lines.slice(-3)).toEqual(['Pasted 60.', 'Four.', 'Five.']);
    } finally { await fixture.close(); }
  });
}

// A page (a dedication, an epigraph) is written in a sheet of its own,
// filled straight from its file.
test('a page opened in its sheet has no line break between paragraphs', async () => {
  const fixture = await launchProfile();
  try {
    await fixture.page.evaluate(async () => {
      const meta = await neo.createBook({ title: 'Dedication', author: 'Test author' });
      meta.kind = 'dedication';
      meta.chapterOrder = ['page-synthetic'];
      await neo.writeBookMeta(meta.id, meta);
      await neo.writeChapter(meta.id, 'page-synthetic', '<p>For one.</p>\n<p>For two.</p>\n');
      await openPageSheet(null, meta, 'Dedication');
    });
    await expect(fixture.page.locator('.ps-body p')).toHaveText(['For one.', 'For two.']);
    expect(await blankChildren(fixture.page, '.ps-body')).toEqual([]);
  } finally { await fixture.close(); }
});

// A chapter file written compact (every book from before the switch, an
// import, a page's starter) is not the writer's change to put right: while
// another chapter is edited, or the book goes back to a snapshot, the bytes
// of the compact chapter stay what they were. Structural undo and Restore
// Whole Book save every chapter of the book.
const SECOND = 'chapter-second';
const COMPACT = '<p>Beta one.</p><p>Beta two.</p>';

// seedBook with a second chapter, whose file is written just as given
async function seedWithSecond(page, html, second) {
  return page.evaluate(async ({ html, chId, second }) => {
    const meta = await neo.createBook({ title: 'Synthetic book', author: 'Test author' });
    meta.chapterOrder = ['chapter-synthetic', chId];
    await neo.writeBookMeta(meta.id, meta);
    await neo.writeChapter(meta.id, 'chapter-synthetic', html);
    await neo.writeChapter(meta.id, chId, second);
    const lib = await neo.readLibrary();
    lib.shelves[0].bookIds.push(meta.id);
    await neo.writeLibrary(lib);
    await openBook(meta.id);
    return meta.id;
  }, { html, chId: SECOND, second });
}

test('a structural undo leaves a compact chapter that was not touched as it is on disk', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedWithSecond(fixture.page, F, COMPACT);
    const second = chapterFile(fixture, bookId, SECOND);
    expect((await onDisk(second)).text).toBe(COMPACT);
    await typeAtEndOf(fixture.page, 2, '');
    for (let i = 0; i < 2; i++) await fixture.page.keyboard.press('Enter'); // a section break
    expect(await fixture.page.evaluate(() => undoStack.length)).toBe(1);
    await fixture.page.keyboard.press('Control+z');
    await expect.poll(() => fixture.page.evaluate(() => undoStack.length)).toBe(0);
    await flush(fixture.page);
    expect((await onDisk(second)).text).toBe(COMPACT);
    expect((await onDisk(chapterFile(fixture, bookId))).text).toBe(F);
    expect(await fixture.page.evaluate(() => ({ order: book.chapterOrder, darlings }))).toEqual({ order: [CHAPTER, SECOND], darlings: [] });
  } finally { await fixture.close(); }
});

test('undo of a quiet delete of a compact chapter writes its file back as it was', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedWithSecond(fixture.page, F, COMPACT);
    const second = chapterFile(fixture, bookId, SECOND);
    await fixture.page.evaluate(async (chId) => {
      snapshotStructure('chapter delete');
      await deleteChapterQuiet(chId);
    }, SECOND);
    await expect(access(second)).rejects.toThrow();
    await fixture.page.evaluate(() => structuralUndo());
    await flush(fixture.page);
    expect(await fixture.page.evaluate(() => book.chapterOrder)).toContain(SECOND);
    expect((await onDisk(second)).text).toBe(COMPACT);
  } finally { await fixture.close(); }
});

test('Restore Whole Book leaves a compact chapter the book did not change as it is on disk', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedWithSecond(fixture.page, F, COMPACT);
    const second = chapterFile(fixture, bookId, SECOND);
    const first = chapterFile(fixture, bookId);
    const name = await fixture.page.evaluate(async () => (await takeSnapshot('k')).snap.name);
    await typeAtEndOf(fixture.page, 1, ' Typed.');
    await flush(fixture.page);
    expect((await onDisk(first)).text).toContain('Typed.');
    await fixture.page.evaluate(async (name) => {
      switchTab('darlings');
      await showSnapshot(name);
      await restoreSnapshot(null);
    }, name);
    await flush(fixture.page);
    expect((await onDisk(first)).text).toBe(F);
    expect((await onDisk(second)).text).toBe(COMPACT);
  } finally { await fixture.close(); }
});
