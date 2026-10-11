'use strict';

// tools/git/neo-compact.js turns a lined chapter file (left by a settled merge
// conflict or an earlier build of this fork) back into the compact HTML Neo
// writes. The rule: compacting a chapter gives exactly the bytes Neo would
// write for that page, and never changes a file that is already compact.
// Every test runs the CLI on files in a temp folder, never on a real library.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const { paragraphLines } = require('../tools/git/neo-lines.js');

const TOOL = path.join(__dirname, '..', 'tools', 'git', 'neo-compact.js');

let sandbox;
let counter = 0;
before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-compact-test-'));
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// A fresh folder per test, so no test sees another's files.
function folder() {
  const dir = path.join(sandbox, `t${++counter}`);
  fs.mkdirSync(dir);
  return dir;
}
function run(...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
function put(file, text) {
  fs.writeFileSync(file, text, 'utf8');
  fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
}
const bytes = (file) => fs.readFileSync(file);
const mtime = (file) => fs.statSync(file).mtimeMs;

// What Neo writes: compact. Shapes taken from the chapter-git spike.
const EDGE = {
  single: '<p>only one</p>',
  'blank paragraph': '<p><br></p><p>x</p>',
  'nested lists': '<p>a</p><ul><li>x<ul><li>y</li><li><p>deep</p><p>deeper</p></li></ul></li><li>z</li></ul><p>b</p><p>c</p><ol><li><p>p1</p><p>p2</p></li></ol><p>d</p>',
  blockquote: '<p>a</p><blockquote><p>q1</p><p>q2</p></blockquote><p>b</p><blockquote>bare quote</blockquote>',
  br: '<p>line<br>two<br></p><p>x<br><br></p><p><br><br></p>',
  'pre and code': '<p>a</p><pre>code\n  line2\n\n    line4 <p>not a tag</p></pre><p>b</p><p>c</p><pre><code>x\n</code></pre>',
  'non-ASCII': '<p>café 日本語 😀 naïve</p><p>Жук nbsp char</p>',
  'newline inside a paragraph': '<p>a <i>b</i>\nc</p><p>d</p>',
  'scene break': '<p>a</p><p class="scene-break">***</p><p><br></p>'
};

test('a lined file becomes the compact bytes Neo writes', () => {
  const file = path.join(folder(), 'c1.html');
  put(file, '<p>one</p>\n<p>two <b>bold</b></p>\n<p>three</p>\n');
  const r = run('--write', file);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(bytes(file), Buffer.from('<p>one</p><p>two <b>bold</b></p><p>three</p>', 'utf8'));
  assert.match(r.out, /changed/);
});

test('every edge shape lined by paragraph compacts to the bytes Neo wrote', () => {
  for (const [name, html] of Object.entries(EDGE)) {
    const file = path.join(folder(), 'c1.html');
    const lined = paragraphLines(html);
    assert.notEqual(lined, html, `${name}: fixture must be lined`);
    put(file, lined);
    const r = run('--write', file);
    assert.equal(r.status, 0, `${name}\n${r.all}`);
    assert.deepEqual(bytes(file), Buffer.from(html, 'utf8'), name);
  }
});

test('a compact file is left alone, bytes and mtime', () => {
  for (const [name, html] of Object.entries(EDGE)) {
    const file = path.join(folder(), 'c1.html');
    put(file, html);
    const before = { data: bytes(file), time: mtime(file) };
    const r = run('--write', file);
    assert.equal(r.status, 0, `${name}\n${r.all}`);
    assert.match(r.out, /unchanged/, `${name}: must have reached the unchanged path`);
    assert.deepEqual(bytes(file), before.data, name);
    assert.equal(mtime(file), before.time, name);
  }
});

test('a dry run lists the file that would change and writes nothing', () => {
  const file = path.join(folder(), 'c1.html');
  const lined = '<p>one</p>\n<p>two</p>\n';
  put(file, lined);
  const before = { data: bytes(file), time: mtime(file) };
  const r = run(file);
  assert.equal(r.status, 0, r.all);
  assert.match(r.out, /would change/);
  assert.ok(r.out.includes(file), r.out);
  assert.deepEqual(bytes(file), before.data);
  assert.equal(mtime(file), before.time);
});

const CONFLICT = '<p>one</p>\n<<<<<<< ours\n<p>two</p>\n=======\n<p>deux</p>\n>>>>>>> theirs\n<p>three</p>\n';

test('a file that still holds conflict markers is refused, named, and left as it was', () => {
  for (const args of [['--write'], []]) {
    const dir = folder();
    const file = path.join(dir, 'c1.html');
    const fine = path.join(dir, 'c2.html');
    put(file, CONFLICT);
    put(fine, '<p>a</p>\n<p>b</p>\n');
    const r = run(...args, file, fine);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.all, /refused/);
    assert.ok(r.all.includes(file), r.all);
    assert.deepEqual(bytes(file), Buffer.from(CONFLICT, 'utf8'));
    assert.equal(mtime(file), new Date('2020-01-01T00:00:00Z').getTime());
  }
});

test('one refused file does not stop the others from being compacted', () => {
  const dir = folder();
  const bad = path.join(dir, 'a.html');
  const good = path.join(dir, 'b.html');
  put(bad, CONFLICT);
  put(good, '<p>a</p>\n<p>b</p>\n');
  const r = run('--write', bad, good);
  assert.notEqual(r.status, 0);
  assert.deepEqual(bytes(good), Buffer.from('<p>a</p><p>b</p>'));
});

test('a file that does not survive lining after compacting is refused and left as it was', () => {
  const shapes = {
    'CRLF line ends': '<p>a</p>\r\n<p>b</p>\r\n',
    'only some paragraphs on their own line': '<p>a</p><p>b</p>\n<p>c</p>',
    'a space between blocks': '<p>a</p> <p>b</p>\n',
    'blank lines between blocks': '<p>a</p>\n\n<p>b</p>\n'
  };
  for (const [name, text] of Object.entries(shapes)) {
    const file = path.join(folder(), 'c1.html');
    put(file, text);
    const r = run('--write', file);
    assert.notEqual(r.status, 0, name);
    assert.match(r.all, /refused/, name);
    assert.ok(r.all.includes(file), name);
    assert.deepEqual(bytes(file), Buffer.from(text, 'utf8'), name);
  }
});

const { writeAtomic } = require('../tools/git/neo-compact.js');

// A library with chapters to find and look-alikes that must be left alone.
function library() {
  const lib = folder();
  const lined = '<p>a</p>\n<p>b</p>\n';
  const files = {
    'book-a/chapters/c1.html': lined,
    'book-a/chapters/c2.html': '<p>a</p><p>b</p>',
    'book-b/chapters/c1.html': lined,
    'book-a/chapters/c3.txt': lined,
    'book-a/chapters/sub/c9.html': lined,
    'book-a/notes.html': lined,
    'book-a/snapshots/s1/c1.html': lined,
    'other/chapters/c1.html': lined,
    'chapters/c1.html': lined
  };
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(lib, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    put(file, text);
  }
  return { lib, lined, files };
}

test('a folder walk finds only book-*/chapters/*.html', () => {
  const { lib, files } = library();
  const r = run('--write', lib);
  assert.equal(r.status, 0, r.all);
  assert.match(r.out, /3 files: 2 changed, 1 unchanged, 0 refused/);
  const touched = ['book-a/chapters/c1.html', 'book-b/chapters/c1.html'];
  for (const [rel, text] of Object.entries(files)) {
    const now = bytes(path.join(lib, ...rel.split('/'))).toString('utf8');
    assert.equal(now, touched.includes(rel) ? '<p>a</p><p>b</p>' : text, rel);
  }
});

test('a second run changes nothing', () => {
  const { lib } = library();
  assert.equal(run('--write', lib).status, 0);
  const snapshot = () => {
    const seen = {};
    for (const rel of ['book-a/chapters/c1.html', 'book-a/chapters/c2.html', 'book-b/chapters/c1.html']) {
      const file = path.join(lib, ...rel.split('/'));
      seen[rel] = { data: bytes(file).toString('latin1'), time: mtime(file) };
    }
    return seen;
  };
  const first = snapshot();
  const r = run('--write', lib);
  assert.equal(r.status, 0, r.all);
  assert.match(r.out, /3 files: 0 changed, 3 unchanged, 0 refused/);
  assert.deepEqual(snapshot(), first);
  assert.doesNotMatch(run(lib).out, /would change \S/);
});

test('a file given twice, or by folder and by name, is handled once', () => {
  const { lib } = library();
  const file = path.join(lib, 'book-a', 'chapters', 'c1.html');
  const r = run(lib, file, file);
  assert.match(r.out, /3 files: 2 would change, 1 unchanged, 0 refused/);
});

test('writeAtomic writes through a temp file in the same folder and leaves no temp behind', () => {
  const dir = folder();
  const file = path.join(dir, 'c1.html');
  put(file, 'old');
  const renames = [];
  writeAtomic(file, '<p>new é</p>', (from, to) => {
    renames.push([from, to]);
    assert.equal(fs.readFileSync(file, 'latin1'), 'old', 'target is untouched until the rename');
    fs.renameSync(from, to);
  });
  assert.equal(renames.length, 1);
  assert.equal(path.dirname(renames[0][0]), dir);
  assert.equal(renames[0][1], file);
  assert.notEqual(renames[0][0], file);
  assert.deepEqual(fs.readdirSync(dir), ['c1.html']);
  assert.equal(fs.readFileSync(file, 'latin1'), '<p>new é</p>');
});

test('a write that fails before the rename leaves the chapter as it was and no temp file', () => {
  const dir = folder();
  const file = path.join(dir, 'c1.html');
  put(file, '<p>a</p>\n<p>b</p>\n');
  assert.throws(() => writeAtomic(file, '<p>a</p><p>b</p>', () => { throw new Error('disk gone'); }), /disk gone/);
  assert.equal(fs.readFileSync(file, 'utf8'), '<p>a</p>\n<p>b</p>\n');
  assert.deepEqual(fs.readdirSync(dir), ['c1.html']);
});

test('a real run leaves no temp files in the library', () => {
  const { lib } = library();
  const list = () => fs.readdirSync(lib, { recursive: true }).sort();
  const before = list();
  assert.equal(run('--write', lib).status, 0);
  assert.deepEqual(list(), before);
});

test('a path that is not there is refused, and no path or an unknown option is a usage error', () => {
  const missing = path.join(folder(), 'nope.html');
  const r = run(missing);
  assert.notEqual(r.status, 0);
  assert.match(r.all, /refused/);
  assert.ok(r.all.includes(missing));
  assert.equal(run().status, 2);
  assert.equal(run('--wrtie', missing).status, 2);
});

test('a chapters folder or a book folder that is a junction or symlink is not followed out of the library', () => {
  const lined = '<p>a</p>\n<p>b</p>\n';
  for (const linkAt of ['chapters', 'book']) {
    const root = folder();
    const outside = path.join(root, 'outside');
    const lib = path.join(root, 'lib');
    fs.mkdirSync(path.join(outside, 'chapters'), { recursive: true });
    const secret = path.join(outside, 'chapters', 'x.html');
    put(secret, lined);
    if (linkAt === 'chapters') {
      fs.mkdirSync(path.join(lib, 'book-x'), { recursive: true });
      fs.symlinkSync(path.join(outside, 'chapters'), path.join(lib, 'book-x', 'chapters'), 'junction');
    } else {
      fs.mkdirSync(lib);
      fs.symlinkSync(outside, path.join(lib, 'book-x'), 'junction');
    }
    assert.ok(fs.lstatSync(linkAt === 'chapters' ? path.join(lib, 'book-x', 'chapters') : path.join(lib, 'book-x')).isSymbolicLink(), 'the link must really be a link');
    const r = run('--write', lib);
    assert.equal(r.status, 0, `${linkAt}\n${r.all}`);
    assert.deepEqual(bytes(secret), Buffer.from(lined), linkAt);
    assert.equal(mtime(secret), new Date('2020-01-01T00:00:00Z').getTime(), linkAt);
  }
});

test('a diff3 base marker also marks a file as unsettled', () => {
  const text = '<p>one</p>\n<<<<<<< ours\n<p>two</p>\n||||||| base\n<p>deux</p>\n=======\n<p>zwei</p>\n>>>>>>> theirs\n';
  const noOthers = '<p>one</p>\n||||||| base\n<p>two</p>\n';
  for (const body of [text, noOthers]) {
    const file = path.join(folder(), 'c1.html');
    put(file, body);
    const r = run('--write', file);
    assert.notEqual(r.status, 0, r.all);
    assert.match(r.all, /conflict markers/);
    assert.deepEqual(bytes(file), Buffer.from(body, 'utf8'));
  }
});
