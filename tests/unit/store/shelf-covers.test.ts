import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

// Rule: the shelf asks the store for each cover once while it is cached, whether the read gave
// an image, no image (gone, or still in iCloud) or an error, so a redraw never re-reads or
// re-logs one; and the cache, failures included, holds at most COVER_CACHE_MAX entries.
// The shelf's own code runs here, in a vm.

type Anything = any;
const shelf = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'app', 'shelf.js'), 'utf8').replace(/\r\n/g, '\n');
const slice = (from: string, to: string) => {
  const a = shelf.indexOf(from);
  const b = shelf.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `the shelf's code moved: ${from}`);
  return shelf.slice(a, b);
};
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

function shelfWindow(answer: (bookId: string, name: string) => Promise<unknown>) {
  const asked: string[] = [];
  const logged: string[] = [];
  const dressed: string[] = [];
  const context = vm.createContext({
    window: { neo: { readCover: (b: string, n: string) => { asked.push(b + '/' + n); return answer(b, n); }, logError: (m: string) => logged.push(String(m)) } },
    NeoCovers: { dress: (el: Anything) => dressed.push(el.id), plan: () => ({}) },
    isScript: () => false,
    coverMode: (m: Anything) => (m.coverImage ? 'image' : 'abstract'),
    artCache: new Map(),
    paintedArt: async () => null,
  });
  vm.runInContext(slice('const coverCache = new Map();', 'async function loadLibrary(') + slice('function dressTile(', 'function bookTile('), context);
  const tile = (id: string) => ({ id, style: { background: '' }, classList: { add() {}, remove() {}, toggle() {} } });
  const draw = async (meta: Anything) => { (vm.runInContext('dressTile', context) as Anything)(tile(meta.id), meta); await settle(); };
  return { asked, logged, dressed, draw, cacheSize: () => vm.runInContext('coverCache.size', context) as number, max: () => vm.runInContext('COVER_CACHE_MAX', context) as number };
}

for (const [how, answer] of [
  ['no image', async () => null],
  ['an error', async () => { throw new Error("Error invoking remote method 'cover:read': boom"); }],
] as const) {
  test(`a cover read that gives ${how} is asked for and logged once, not at every redraw`, async () => {
    const w = shelfWindow(answer);
    const meta = { id: 'book-a', coverImage: 'cover-1.png' };
    await w.draw(meta);
    await w.draw(meta);
    await w.draw(meta);
    assert.deepEqual(w.asked, ['book-a/cover-1.png'], 'asked for once');
    assert.equal(w.logged.length, 1, 'logged once');
    assert.equal(w.dressed.filter((id) => id === 'book-a').length, 3, 'and every redraw shows the abstract cover');
  });
}

test('a cover read that gives an image is asked for once too, and the cache, failures included, keeps its cap', async () => {
  const w = shelfWindow(async (_b, n) => (n.startsWith('cover-ok') ? { mime: 'image/png', base64: 'AAAA' } : null));
  await w.draw({ id: 'book-ok', coverImage: 'cover-ok.png' });
  await w.draw({ id: 'book-ok', coverImage: 'cover-ok.png' });
  assert.deepEqual(w.asked, ['book-ok/cover-ok.png']);
  assert.equal(w.logged.length, 0);
  for (let i = 0; i < w.max() + 20; i++) await w.draw({ id: 'book-' + i, coverImage: 'cover-1.png' });
  assert.ok(w.cacheSize() > 1, 'failures are cached');
  assert.ok(w.cacheSize() <= w.max(), `the cache holds at most ${w.max()}`);
});
