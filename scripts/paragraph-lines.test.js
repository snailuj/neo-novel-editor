'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// how a chapter file is laid out on disk (paragraphLines), run on its own
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(app.slice(app.indexOf('function paragraphLines('), app.indexOf('// One write at a time per chapter')), context);
vm.runInContext('this.api = { paragraphLines };', context);
const { paragraphLines } = context.api;

test('each paragraph of a chapter file stands on its own line', () => {
  assert.equal(paragraphLines('<p>a</p><p class="scene-break">***</p><p><br></p>'),
    '<p>a</p>\n<p class="scene-break">***</p>\n<p><br></p>\n');
});

test('a chapter already set one paragraph per line is left as it is', () => {
  const once = paragraphLines('<p>a</p><p class="scene-break">***</p><p><br></p>');
  assert.equal(paragraphLines(once), once);
});

test('a line break inside a paragraph is the paragraph\'s own and stays', () => {
  assert.equal(paragraphLines('<p>a <i>b</i>\nc</p>'), '<p>a <i>b</i>\nc</p>\n');
});

test('blank lines and spaces between paragraphs come down to one line break', () => {
  assert.equal(paragraphLines('<p>a</p>\n\n  <p>b</p>'), '<p>a</p>\n<p>b</p>\n');
});

// A book in memory, saved through persistChapter to a disk that only notes
// what it is handed
const SLICES = [
  ['const diskKnown = {};', '// Another device\'s version of a chapter']
];
function bookInMemory(chapters) {
  const writes = [];
  const page = vm.createContext({
    window: { neo: { writeChapter: async (bookId, chId, html) => { writes.push({ chId, html }); return true; } } },
    book: { id: 'b', chapterOrder: Object.keys(chapters) },
    chapterHTML: { ...chapters },
    savedHTML: { ...chapters },
    writing: {}
  });
  for (const [from, to] of SLICES) vm.runInContext(app.slice(app.indexOf(from), app.indexOf(to)), page);
  return { page, writes };
}

const F = '<p>First line.</p>\n<p>Second line.</p>\n<p>Third line.</p>\n';

test('a chapter goes to disk one paragraph per line', async () => {
  const { page, writes } = bookInMemory({ x: F });
  await page.persistChapter('x', '<p>a</p><p>b</p>');
  assert.deepEqual(writes, [{ chId: 'x', html: '<p>a</p>\n<p>b</p>\n' }]);
  assert.equal(page.savedHTML.x, '<p>a</p>\n<p>b</p>\n');
});

// flushAllSaves writes every chapter whose page copy differs from savedHTML
test('the page\'s copy takes the saved form, so the flush finds nothing left to write', async () => {
  const { page } = bookInMemory({ x: F, twin: F });
  // a paragraph typed on the page has no line break of its own yet
  page.chapterHTML.x = F + '<p>Fourth.</p>';
  await page.persistChapter('x');
  assert.equal(page.chapterHTML.x, F + '<p>Fourth.</p>\n');
  assert.equal(page.chapterHTML.x, page.savedHTML.x);
  // another device's copy, handed in compact as keepOtherDeviceVersion does
  page.chapterHTML.twin = '<p>Other.</p><p>Device.</p>';
  await page.persistChapter('twin', '<p>Other.</p><p>Device.</p>');
  assert.equal(page.chapterHTML.twin, '<p>Other.</p>\n<p>Device.</p>\n');
  assert.equal(page.chapterHTML.twin, page.savedHTML.twin);
});

test('text handed in that the page no longer holds leaves the page alone', async () => {
  const { page } = bookInMemory({ x: '<p>Newer.</p>' });
  await page.persistChapter('x', '<p>Older.</p>');
  assert.equal(page.chapterHTML.x, '<p>Newer.</p>');
  assert.equal(page.savedHTML.x, '<p>Older.</p>\n');
});

// structural undo hands back chapters whose files the action deleted, and
// savedHTML still holds their last write
test('a write the same as the last one still goes to disk', async () => {
  const { page, writes } = bookInMemory({ x: F });
  await page.persistChapter('x', F);
  assert.deepEqual(writes, [{ chId: 'x', html: F }]);
});
