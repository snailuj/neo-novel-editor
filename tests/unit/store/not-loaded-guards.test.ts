import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

// Rule: an action that would save, move or split a chapter not loaded here (see loadChapter
// in app/core.js) is refused up front with the not-read toast, and changes nothing.
// The window's own code runs here, in a vm.

type Anything = any;
const root = path.join(import.meta.dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const slice = (source: string, from: string, to: string) => {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `the window's code moved: ${from}`);
  return source.slice(a, b);
};
const core = read('app/core.js');

function windowWith(code: string) {
  const toasts: string[] = [];
  const calls: string[] = [];
  const context = vm.createContext({
    window: { neo: { logError() {}, duplicateBook: async () => { calls.push('duplicate'); return { id: 'copy' }; } } },
    console: { error() {} },
    setTimeout: (fn: () => void) => { fn(); return 0; },
    t: (s: string, v?: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k) => v?.[k] ?? ''),
    toast: (m: string) => toasts.push(m),
    chapterName: (id: string) => `Chapter ${id}`,
    calls,
    // the rest of the window, which records what was asked of it
    persistChapter: async (c: string) => { calls.push('persist ' + c); },
    flushAllSaves: () => calls.push('flush'), saveMeta: async () => { calls.push('saveMeta'); },
    snapshotStructure: () => calls.push('snapshot'), createChapterAt: () => { calls.push('create'); return 'new'; },
    sectionWritten: () => false, scheduleMetaSave: () => calls.push('scheduleMeta'), syncGhosts: () => {}, renderOutline: () => {},
    plainError: String, bookMetaCache: { set() {} }, library: { shelves: [{ id: 's', bookIds: ['b'] }] }, isBound: () => false, writeLibrary: async () => {}, renderShelves: () => {},
  });
  vm.runInContext('let book = null, chapterHTML = {}, savedHTML = {};', context);
  vm.runInContext(slice(core, 'function storeErrorCode(', '// index.html marks its words'), context);
  vm.runInContext(code, context);
  const run = (c: string) => vm.runInContext(c, context) as Anything;
  run(`book = { id: 'b', title: 'Salt Roads', chapterOrder: ['a', 'stuck'], chapterNotes: {}, sectionNotes: { stuck: [{ id: 's1', text: 'one' }, { id: 's2', text: 'two' }] } };
       chapterHTML = { a: '<p>typed</p>', stuck: '<p>changed somehow</p>' }; savedHTML = { a: '', stuck: '' };
       unloadedChapters.add('b/stuck');`);
  return { run, toasts, calls };
}

test('duplicating the open book while a chapter is not loaded is refused, before any save', async () => {
  const w = windowWith(slice(read('app/shelf.js'), 'async function duplicateBook(', '\n}\n') + '\n}');
  await w.run('duplicateBook(book)');
  assert.deepEqual(w.calls, [], 'nothing was saved or copied');
  assert.equal(w.toasts.filter((m) => m.includes('Chapter stuck') && m.includes('could not be read')).length, 1);
  w.run("unloadedChapters.delete('b/stuck')");
  await w.run('duplicateBook(book)').catch(() => {});
  assert.ok(w.calls.includes('duplicate'), 'once it is loaded the book is copied');
});

test('Shift-Tab on a section of a chapter not loaded is refused, and its section notes stay', () => {
  const w = windowWith(slice(read('app/tabs.js'), 'function outlineSectionToChapter(', 'function outlineLine('));
  const before = JSON.stringify(w.run('book'));
  w.run("outlineSectionToChapter('stuck', 's1', null)");
  assert.equal(JSON.stringify(w.run('book')), before, 'nothing in the book changed');
  assert.deepEqual(w.calls, [], 'no chapter was made');
  assert.equal(w.toasts.filter((m) => m.includes('could not be read')).length, 1);
  w.run("unloadedChapters.delete('b/stuck')");
  w.run("outlineSectionToChapter('stuck', 's2', null)");
  assert.ok(w.calls.includes('create'), 'once it is loaded the section becomes a chapter');
});
