import { test, expect } from '@playwright/test';
import {
  blocksOf, caretAt, LINES, pageBeside, pageFile, selectIn, shownBlocks,
} from '../support/pane-page.mjs';

// The wiki pane as a full editor of a stored page, on the browser's own contenteditable
// editing. Rules (one sentence each, true for every path):
//  1 Enter makes a block whose id is new, six hex digits and never used on the page this
//    session; the block that keeps the words keeps its id and class.
//  2 Joining two blocks leaves one block with the upper id, and the lower id stays on it as
//    an alias (Join-Keeps-Both-Ids); words joined into an empty block keep their own id.
//  3 Bold and italic in the pane change the pane's page and never the open book.
//  4 Undo and redo in the pane step back and forward through the pane's edits, ids staying
//    unique, and NEO's own undo handling neither clears nor takes them.
//  5 Pasted rich text enters through NEO's cleanPasteHtml and only allowed tags stay.
//  6 A save changes only the bytes of blocks the writer touched.
//  7 Marks are drawn again on the page as it is after a split or join; NEO's shortcuts
//    leave the pane's keys alone.
//  8 A real link or image is one locked piece of the text, typed around and kept on save.

// b2 and b3 carry what the pane does not show (style, data-keep, odd spacing): untouched, they must keep it
const B0 = '<p class="wiki-h1" data-block="h1">Vell</p>';
const B1 = '<p data-block="b1">The harbour of Vell faces west.</p>';
const B2 = '<p class="wiki-quote" data-keep="x" style="color:red" data-block="b2">Its keeper rows at dawn.</p>';
const B3 = '<p  data-block="b3"  data-secret="1">Last line &amp; more.</p>';
const HTML = B0 + B1 + B2 + B3;
const ORIGINAL = [['wiki-h1', 'h1', 'Vell', ''], ['', 'b1', 'The harbour of Vell faces west.', ''], ['wiki-quote', 'b2', 'Its keeper rows at dawn.', ''], ['', 'b3', 'Last line & more.', '']];

async function withPane(fn, html = HTML) {
  const { fixture, page, library } = await pageBeside(html);
  try {
    expect(await shownBlocks(page)).toEqual(html === HTML ? ORIGINAL : expect.anything());
    await fn({
      fixture, page, library,
      file: () => pageFile(library),
      shown: () => shownBlocks(page),
      bookNow: () => page.evaluate(() => document.querySelector('.chapter-body').innerHTML),
      caret: (words, at) => caretAt(page, words, at),
      select: (words) => selectIn(page, words),
    });
  } finally {
    await fixture.close();
  }
}

const isFresh = (id, others) => /^[0-9a-f]{6}$/.test(id) && !others.includes(id);

// Rule 1.
test('Enter splits a block: the first half keeps its id and class, the new block has a fresh id and the same class', async () => {
  await withPane(async ({ page, file, shown, caret }) => {
    // a quote block, split mid-words
    await caret('keeper');
    await page.keyboard.press('Enter');
    const after = await shown();
    expect(after.map((b) => b[2])).toEqual(['Vell', 'The harbour of Vell faces west.', 'Its keeper', ' rows at dawn.', 'Last line & more.']);
    expect(after[2].slice(0, 2)).toEqual(['wiki-quote', 'b2']);
    expect(after[3][0]).toBe('wiki-quote');
    expect(isFresh(after[3][1], ['h1', 'b1', 'b2', 'b3'])).toBe(true);
    await expect.poll(() => blocksOf(file()).length).toBe(5);
    const saved = blocksOf(file());
    expect(saved[2].slice(0, 2)).toEqual(['wiki-quote', 'b2']);
    expect(saved[3]).toEqual(['wiki-quote', after[3][1], ' rows at dawn.', '']);
    // a second Enter in the new block gives a third id, none shared
    await page.keyboard.press('Enter');
    const ids = (await shown()).map((b) => b[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

test('Enter at a block\'s start leaves the words with their id, and at its end adds an empty block', async () => {
  await withPane(async ({ page, shown, caret, file }) => {
    await caret('The harbour', 'start');
    await page.keyboard.press('Enter');
    let now = await shown();
    expect(now.map((b) => b[2])).toEqual(['Vell', '', 'The harbour of Vell faces west.', 'Its keeper rows at dawn.', 'Last line & more.']);
    expect(now[2][1]).toBe('b1');
    expect(isFresh(now[1][1], ['h1', 'b1', 'b2', 'b3'])).toBe(true);
    await caret('more.', 'end');
    await page.keyboard.press('Enter');
    now = await shown();
    expect(now.at(-1)[2]).toBe('');
    expect(now.at(-1)[1]).not.toBe('b3');
    const ids = now.map((b) => b[1]);
    expect(new Set(ids).size).toBe(ids.length);
    await expect.poll(() => file().includes('<br>')).toBe(true);
  });
});

test('a new block never takes an id used on the page this session, a removed one included', async () => {
  await withPane(async ({ page, shown, caret }) => {
    // an id made by Enter and removed again before it was saved
    await caret('west.');
    await page.keyboard.press('Enter');
    const made = (await shown())[2][1];
    expect(isFresh(made, ['h1', 'b1', 'b2', 'b3'])).toBe(true);
    await page.keyboard.press('Backspace');
    expect((await shown()).map((b) => b[1])).toEqual(['h1', 'b1', 'b2', 'b3']);
    // the next random draws are that id, then one never seen
    await page.evaluate((made) => {
      const draws = [made, 'c0ffee'];
      const real = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = (bytes) => {
        const next = draws.shift();
        if (!next || bytes.length !== 3) return real(bytes);
        for (let i = 0; i < 3; i++) bytes[i] = parseInt(next.slice(i * 2, i * 2 + 2), 16);
        return bytes;
      };
    }, made);
    await page.keyboard.press('Enter');
    expect((await shown())[2][1]).toBe('c0ffee');
  });
});

// Rule 2.
test('Backspace at a block\'s start joins it to the one above, which keeps the lower id as an alias', async () => {
  await withPane(async ({ page, shown, caret, file }) => {
    await caret('Its keeper', 'start');
    await page.keyboard.press('Backspace');
    const now = await shown();
    expect(now.map((b) => b[2])).toEqual(['Vell', 'The harbour of Vell faces west.Its keeper rows at dawn.', 'Last line & more.']);
    expect(now[1]).toEqual(['', 'b1', 'The harbour of Vell faces west.Its keeper rows at dawn.', 'b2']);
    await expect.poll(() => blocksOf(file()).length).toBe(3);
    expect(file()).toContain('<p data-block="b1" data-alias="b2">The harbour of Vell faces west.Its keeper rows at dawn.</p>');
    // the untouched last block keeps its odd spacing and attribute
    expect(file().endsWith(B3)).toBe(true);

    // undone, the lower block is back with its id, and the alias goes with the join
    await page.keyboard.press('Control+z');
    expect(await shown()).toEqual(ORIGINAL);
    await expect.poll(() => file()).toBe(HTML);
  });
});

test('words joined into an empty block above keep their own id, and the empty block\'s id stays as an alias', async () => {
  const html = B0 + '<p data-block="e1"><br></p>' + B1;
  await withPane(async ({ page, shown, caret, file }) => {
    expect((await shown()).map((b) => b[1])).toEqual(['h1', 'e1', 'b1']);
    await caret('The harbour', 'start');
    await page.keyboard.press('Backspace');
    expect(await shown()).toEqual([['wiki-h1', 'h1', 'Vell', ''], ['', 'b1', 'The harbour of Vell faces west.', 'e1']]);
    await expect.poll(() => file()).toBe(B0 + '<p data-block="b1" data-alias="e1">The harbour of Vell faces west.</p>');
    // undone, each block has its own id again
    await page.keyboard.press('Control+z');
    expect(await shown()).toEqual([['wiki-h1', 'h1', 'Vell', ''], ['', 'e1', '', ''], ['', 'b1', 'The harbour of Vell faces west.', '']]);
    await expect.poll(() => file()).toBe(B0 + '<p data-block="e1"><br></p>' + B1);
  }, html);
});

// Rule 3.
test('Ctrl+B and Ctrl+I format the pane\'s words and leave the open book alone', async () => {
  await withPane(async ({ page, shown, select, file, bookNow }) => {
    const book = await bookNow();
    expect(book).toContain('See [[Vell]] today.');
    await select('harbour');
    await page.keyboard.press('Control+b');
    await expect(page.locator(`${LINES} b`)).toHaveText('harbour');
    await select('keeper');
    await page.keyboard.press('Control+i');
    await expect(page.locator(`${LINES} i`)).toHaveText('keeper');
    await expect.poll(() => file()).toContain('The <b>harbour</b> of Vell faces west.');
    expect(file()).toContain('Its <i>keeper</i> rows at dawn.');
    expect(await bookNow()).toBe(book);
    // the quote block kept the attributes the pane does not show
    expect(file()).toContain('<p class="wiki-quote" data-keep="x" style="color:red" data-block="b2">Its <i>keeper</i>');
    expect((await shown()).length).toBe(4);
  });
});

// Rule 4.
test('undo and redo work after the id fix has touched the DOM', async () => {
  await withPane(async ({ page, shown, caret, file, fixture }) => {
    const original = (await shown()).map((b) => b.join('|'));
    await caret('harbour');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second');
    const split = (await shown()).map((b) => b.join('|'));
    expect(split.length).toBe(5);
    const freshId = (await shown())[2][1];
    // undo straight away, before any save: typing, then the split
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await shown()).map((b) => b[2])[2]).not.toContain('Second');
    await page.keyboard.press('Control+z');
    expect((await shown()).map((b) => b.join('|'))).toEqual(original);
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+y');
    expect((await shown()).map((b) => b.join('|'))).toEqual(split);
    expect((await shown())[2][1]).toBe(freshId);
    await expect.poll(() => blocksOf(file()).length).toBe(5);
    // undo after the save, then redo, ids unique at each step
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    expect((await shown()).map((b) => b.join('|'))).toEqual(original);
    await expect.poll(() => file()).toBe(HTML);
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+Shift+z');
    const again = (await shown());
    expect(again.map((b) => b.join('|'))).toEqual(split);
    const ids = again.map((b) => b[1]);
    expect(new Set(ids).size).toBe(ids.length);
    await expect.poll(() => blocksOf(file()).length).toBe(5);
    // the menu role's undo (webContents.undo) steps back the same way
    await fixture.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
    await fixture.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.undo());
    expect((await shown()).map((b) => b.join('|'))).toEqual(original);
  });
});

// Rule 4: NEO calls resetNativeUndo (app.js) after its structural actions in the book, which
// turns the caret's chapter body uneditable and editable again.
test('NEO\'s resetNativeUndo in the book leaves the pane\'s undo whole', async () => {
  await withPane(async ({ page, shown, caret }) => {
    await caret('keeper');
    await page.keyboard.type(' old');
    expect((await shown())[2][2]).toBe('Its keeper old rows at dawn.');
    // the writer goes to the book, where NEO resets the engine's undo for its chapter
    await page.locator('.chapter-body p').first().click();
    const reset = await page.evaluate(() => {
      const body = document.querySelector('.chapter-body');
      const seen = [];
      const watch = new MutationObserver((records) => { for (const r of records) seen.push(r.attributeName); });
      watch.observe(body, { attributes: true, attributeFilter: ['contenteditable'] });
      resetNativeUndo();
      return new Promise((resolve) => setTimeout(() => { watch.disconnect(); resolve(seen); }, 50));
    });
    // the reset ran: it toggled the chapter body's contenteditable
    expect(reset.length).toBeGreaterThanOrEqual(2);
    // back in the pane, Ctrl+Z still takes back what was typed there
    await caret('old');
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await shown())[2][2]).toBe('Its keeper rows at dawn.');
  });
});

// Rule 4: NEO's structural redo listens for Ctrl+Shift+Z and Ctrl+Y on the whole document
// while its redo list holds anything (app.js); in the pane those keys are the pane's.
test('Ctrl+Shift+Z and Ctrl+Y redo in the pane while NEO has a structural redo waiting', async () => {
  await withPane(async ({ page, shown, caret, bookNow }) => {
    await caret('keeper');
    await page.keyboard.type(' old');
    await page.keyboard.press('Control+z');
    expect((await shown())[2][2]).toBe('Its keeper rows at dawn.');
    // a structural action and its undo in the book leave NEO a redo waiting
    await page.locator('.chapter-body p').first().click();
    await page.evaluate(async () => { snapshotStructure('test'); await structuralUndo(); });
    expect(await page.evaluate(() => redoStack.length)).toBe(1);
    const book = await bookNow();
    await caret('keeper');
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await shown())[2][2]).toBe('Its keeper old rows at dawn.');
    expect(await bookNow()).toBe(book);
    // the pane's typing ends NEO's redo, as any typing does (app.js)
    expect(await page.evaluate(() => redoStack.length)).toBe(0);

    // once more with Ctrl+Y
    await page.keyboard.press('Control+z');
    await page.locator('.chapter-body p').first().click();
    await page.evaluate(async () => { snapshotStructure('test'); await structuralUndo(); });
    expect(await page.evaluate(() => redoStack.length)).toBe(1);
    await caret('keeper');
    await page.keyboard.press('Control+y');
    await expect.poll(async () => (await shown())[2][2]).toBe('Its keeper old rows at dawn.');
  });
});

// Rule 5.
test('pasted rich text goes through cleanPasteHtml and keeps only allowed tags', async () => {
  await withPane(async ({ page, shown, caret, file, fixture }) => {
    await page.evaluate(() => {
      window.__clean = 0;
      const real = window.cleanPasteHtml;
      window.cleanPasteHtml = (...a) => { window.__clean++; return real(...a); };
    });
    const html = '<meta charset="utf-8"><div><p>One <b>bold</b> and <i>it</i></p><p>Two <script>x()</script><span style="font-style:italic">three</span> <a href="http://example.com">link</a><img src="x.png"> four</p></div>';
    await fixture.app.evaluate(({ clipboard }, html) => clipboard.write({ text: 'One bold and it\nTwo three link four', html }), html);
    await caret('more.', 'end');
    await page.keyboard.press('Control+v');
    expect(await page.evaluate(() => window.__clean)).toBeGreaterThan(0);
    // the engine wraps pasted runs in style-only spans, which the page's HTML never keeps
    const tags = await page.evaluate(() => [...new Set([...document.querySelectorAll('.hoard-wiki-page > p *')].filter((e) => !e.matches('button.hoard-wiki-link, span.hoard-wiki-missing, span[style]')).map((e) => e.tagName))].sort());
    expect(tags.every((t) => ['B', 'I', 'U', 'S', 'EM', 'STRONG', 'CODE', 'BR'].includes(t))).toBe(true);
    expect(tags).toContain('B');
    const now = await shown();
    expect(now.map((b) => b[2]).slice(3)).toEqual(['Last line & more.One bold and it', 'Two three link four']);
    const ids = now.map((b) => b[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
    await expect.poll(() => file()).toContain('One <b>bold</b> and <i>it</i></p>');
    expect(file()).not.toMatch(/<(a|img|script|span)[ >]/);
  });
});

// Rule 6.
test('a save is a block patch: untouched blocks keep every byte, touched ones keep the attributes the pane hides', async () => {
  await withPane(async ({ page, caret, file }) => {
    await caret('keeper');
    await page.keyboard.press('Enter');
    await page.keyboard.type('X');
    await expect.poll(() => blocksOf(file()).length).toBe(5);
    const saved = file();
    expect(saved.startsWith(B0 + B1)).toBe(true);
    expect(saved.endsWith(B3)).toBe(true);
    // the touched block keeps its stored opening tag, the new one is made from what the pane shows
    expect(saved).toContain('<p class="wiki-quote" data-keep="x" style="color:red" data-block="b2">Its keeper</p>');
    expect(saved).toMatch(/<p class="wiki-quote" data-block="[0-9a-f]{6}">X rows at dawn\.<\/p>/);
  });
});

// Rule 7.
test('marks are drawn again on the page after a split and a join', async () => {
  await withPane(async ({ page, caret, shown, select }) => {
    await select('dawn');
    await page.locator('.hoard-pane-add').click({ force: true });
    await page.locator('#hoard-pane-compose-text').fill('Which dawn?');
    await page.locator('#hoard-pane-compose-text').press('Control+Enter');
    const marked = () => page.evaluate(() => [...(CSS.highlights.get('hoard-pane-comment') ?? [])].map((r) => {
      const line = [...document.querySelectorAll('.hoard-wiki-page > p')].findIndex((p) => p.contains(r.startContainer));
      return [r.toString(), line];
    }));
    await expect.poll(marked).toEqual([['dawn', 2]]);
    // split before the marked words: the mark follows them into the new block, at once
    await caret('rows ');
    await page.keyboard.press('Enter');
    await expect.poll(marked).toEqual([['dawn', 3]]);
    expect((await shown())[3][2]).toBe('at dawn.');
    // join them again
    await page.keyboard.press('Backspace');
    await expect.poll(marked).toEqual([['dawn', 2]]);
    // a split through the marked words leaves the mark not found
    await caret('da');
    await page.keyboard.press('Enter');
    await expect(page.locator('.hoard-pane-marks .hoard-mark.stale')).toHaveCount(1);
  });
});

test('NEO\'s shortcuts leave the pane\'s keys alone', async () => {
  await withPane(async ({ page, caret, shown, bookNow, file }) => {
    const book = await bookNow();
    await caret('keeper');
    // typing in the pane takes NEO's typography, as other fields do
    await page.keyboard.type(' said "hello" -- ok');
    expect((await shown())[2][2]).toContain('said “hello” — ok');
    for (const key of ['Enter', 'Backspace', 'Control+b', 'Control+i', 'Control+u', 'Control+z', 'Control+y', 'Control+a', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'PageDown', 'Delete']) {
      await page.keyboard.press(key);
      const inPane = await page.evaluate(() => document.activeElement === document.querySelector('.hoard-wiki-page'));
      expect(inPane, key).toBe(true);
    }
    expect(await bookNow()).toBe(book);
    await expect(page.locator('#editor-view')).toBeVisible();
    await expect.poll(() => file().includes('hello')).toBe(true);
  });
});

// Rule 7: the keys NEO takes from the whole window (app.js) are not heard while the caret is in the pane
test('the chords NEO takes from the whole window do not act on the book from the pane', async () => {
  await withPane(async ({ page, caret, bookNow }) => {
    const book = await bookNow();
    expect(book).toContain('See [[Vell]] today.');
    // a key NEO's window-wide handlers took has been defaultPrevented by the time it reaches the window
    await page.evaluate(() => { window.__taken = []; window.addEventListener('keydown', (e) => { if (e.defaultPrevented) window.__taken.push(e.key); }); });
    for (const key of ['Control+Shift+x', 'Control+Shift+d', 'Control+s', 'Control+Enter', 'Control+Shift+z', 'Control+y']) {
      await caret('keeper');
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      expect(await bookNow(), key).toBe(book);
      expect(await page.locator('#editor-view').isVisible(), key).toBe(true);
    }
    expect(await page.evaluate(() => window.__taken)).toEqual([]);
  });
});

// A triple click selects to the start of the next block; typing over it must not join the two.
test('typing over a triple-clicked block keeps the block and its neighbour', async () => {
  await withPane(async ({ page, shown, file }) => {
    await page.locator(LINES).nth(1).click({ clickCount: 3 });
    await page.keyboard.type('Gone.');
    expect(await shown()).toEqual([ORIGINAL[0], ['', 'b1', 'Gone.', ''], ORIGINAL[2], ORIGINAL[3]]);
    await expect.poll(() => file()).toBe(B0 + '<p data-block="b1">Gone.</p>' + B2 + B3);
  });
});

// Rule 8.
test('a real link or image is a locked chip, typed around and kept on save as written', async () => {
  const link = '<a href="https://example.com/vell" title="Vell">the port</a>';
  const image = '<img src="maps/vell.png" alt="Map of Vell">';
  const html = B0 + `<p data-block="b1">See ${link} and ${image} here.</p>`;
  await withPane(async ({ page, shown, caret, file }) => {
    const chips = page.locator(`${LINES} .hoard-wiki-chip`);
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute('contenteditable', 'false');
    await expect(chips.nth(1)).toHaveAttribute('aria-label', 'Image: Map of Vell');
    // nothing live: no anchor or image element in the pane, and the text reads as the file's
    expect(await page.locator(`${LINES} a, ${LINES} img`).count()).toBe(0);
    expect((await shown())[1][2]).toBe('See the port and  here.');
    // typed around: words before the link and after the image
    await caret('See ', 'after');
    await page.keyboard.type('also ');
    await caret(' here.', 'start');
    await page.keyboard.type(' too');
    expect((await shown())[1][2]).toBe('See also the port and  too here.');
    await expect.poll(() => file()).toBe(B0 + `<p data-block="b1">See also ${link} and ${image} too here.</p>`);
    // Backspace after a chip takes the chip, and undo puts it back whole
    await caret(' too here.', 'start');
    await page.keyboard.press('Backspace');
    await expect(chips).toHaveCount(1);
    await page.keyboard.press('Control+z');
    await expect(chips).toHaveCount(2);
    await page.waitForTimeout(1200);
    expect(file()).toBe(B0 + `<p data-block="b1">See also ${link} and ${image} too here.</p>`);
  }, html);
});
