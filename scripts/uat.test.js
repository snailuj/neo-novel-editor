'use strict';

// Rule: preparing a UAT copy only ever reads the real library and vaults, and
// later launches keep the copy (and whatever testing did to it) until --reset.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepare } = require('./uat.js');

function tree(dir) {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
  })(dir);
  return out;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-uat-'));
  const library = path.join(base, 'NEO Library');
  write(path.join(library, 'library.json'), '{"shelves":[]}');
  write(path.join(library, 'book-a-1', 'chapters', 'c1.html'), '<p>One.</p>');
  write(path.join(library, 'Backups', 'neo-backup-2026-10-16.zip'), 'zip');
  write(path.join(library, '.git', 'HEAD'), 'ref: refs/heads/main');
  const vault = path.join(base, 'vault');
  write(path.join(vault, '.obsidian', 'app.json'), '{}');
  write(path.join(vault, 'lore', 'Vell.md'), '# Vell');
  write(path.join(vault, '.git', 'HEAD'), 'ref: refs/heads/main');
  write(path.join(vault, 'node_modules', 'x', 'index.js'), '');
  const home = path.join(base, 'NEO UAT');
  return { base, library, vault, home };
}

test('the sources are only read, and the copy holds what testing needs', () => {
  const f = fixture();
  const before = { library: tree(f.library), vault: tree(f.vault) };
  const made = prepare({ home: f.home, realLibrary: f.library, settings: { language: 'en' }, vaults: [f.vault] });
  assert.deepStrictEqual(tree(f.library), before.library);
  assert.deepStrictEqual(tree(f.vault), before.vault);

  const lib = tree(made.library);
  assert.ok(lib['library.json'] && lib['book-a-1/chapters/c1.html'] && lib['.git/HEAD'], 'books and the library\'s own history come along');
  assert.ok(!Object.keys(lib).some((k) => k.startsWith('Backups/')), 'daily backups stay behind');
  const v = tree(made.vaults[0]);
  assert.deepStrictEqual(Object.keys(v).sort(), ['.obsidian/app.json', 'lore/Vell.md']);
  const settings = JSON.parse(fs.readFileSync(path.join(f.home, 'settings', 'settings.json'), 'utf8'));
  assert.deepStrictEqual(settings, { language: 'en', libraryDir: made.library });
});

test('a later launch keeps the copy as testing left it, and --reset starts again', () => {
  const f = fixture();
  const first = prepare({ home: f.home, realLibrary: f.library, settings: {}, vaults: [f.vault] });
  write(path.join(first.library, 'book-a-1', 'chapters', 'c1.html'), '<p>Edited in UAT.</p>');
  write(path.join(f.library, 'book-a-1', 'chapters', 'c1.html'), '<p>Edited for real.</p>');
  const again = prepare({ home: f.home, realLibrary: f.library, settings: {}, vaults: [f.vault] });
  assert.strictEqual(again.copied, false);
  assert.strictEqual(fs.readFileSync(path.join(again.library, 'book-a-1', 'chapters', 'c1.html'), 'utf8'), '<p>Edited in UAT.</p>');
  const reset = prepare({ home: f.home, realLibrary: f.library, settings: {}, vaults: [f.vault], reset: true });
  assert.strictEqual(reset.copied, true);
  assert.strictEqual(fs.readFileSync(path.join(reset.library, 'book-a-1', 'chapters', 'c1.html'), 'utf8'), '<p>Edited for real.</p>');
});

test('a folder the UAT script did not make is never cleared', () => {
  const f = fixture();
  write(path.join(f.home, 'mine.txt'), 'keep');
  assert.throws(() => prepare({ home: f.home, realLibrary: f.library, settings: {}, vaults: [], reset: true }), /didn't make/);
  assert.strictEqual(fs.readFileSync(path.join(f.home, 'mine.txt'), 'utf8'), 'keep');
});

test('a vault inside the UAT folder, or the library inside a vault, is refused', () => {
  const f = fixture();
  assert.throws(() => prepare({ home: f.home, realLibrary: f.library, settings: {}, vaults: [path.join(f.home, 'x')] }), /inside/);
  assert.throws(() => prepare({ home: f.home, realLibrary: f.library, settings: {}, vaults: [f.base] }), /inside/);
});
