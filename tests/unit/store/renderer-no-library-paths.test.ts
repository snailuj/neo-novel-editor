import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Rule: the window never opens a library file itself, so it never builds a path or a file://
// URL to one. Covers reach it through cover:read, as data. The window may be told the library
// folder's name to show the writer (the "can't save in {dir}" note), and plugins-main.js hands
// the folder to plugins; nothing else may name it.
//
// Every use of a name that holds the library folder is on this list, line by line. A new use
// fails here until it is looked at and added, with a reason.

const root = path.join(import.meta.dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const RENDERER_FILES = [
  ...fs.readdirSync(path.join(root, 'app')).filter((f) => f.endsWith('.js')).map((f) => `app/${f}`),
  'preload.js', 'plugins-main.js', 'plugins.js',
];

// the names under which the library folder reaches the window or a plugin
const LIBRARY_PATH_NAMES = /\b(?:libraryDirPath|libraryPath|libraryDir|LIBRARY_DIR|paths\.library|library:path)\b|\blibrary\s*:\s*\(\)\s*=>/;

const ALLOWED: { file: string; line: string; why: string }[] = [
  { file: 'app/shelf.js', line: "let libraryDirPath = '';", why: 'holds the folder to show in the cannot-save note' },
  { file: 'app/shelf.js', line: 'libraryDirPath = await window.neo.libraryPath();', why: 'asks main.js for it' },
  { file: 'app/shelf.js', line: "{ dir: libraryDirPath });", why: 'shown to the writer, never opened' },
  { file: 'preload.js', line: "libraryPath: () => ipcRenderer.invoke('library:path'),", why: 'the channel that tells the window the folder to show' },
  // Documented exception: removed in a later stage, when the librarian moves to the server.
  { file: 'plugins-main.js', line: 'paths: Object.freeze({ library: () => host.libraryDir(), userData: host.app.getPath(\'userData\'), plugin: folder }),', why: 'paths.library() for plugins, until Librarian-Moves-To-Server' },
];

const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);
const code = (text: string) => text.split('\n').map((line, i) => ({ line: line.trim(), n: i + 1 })).filter((l) => l.line && !isComment(l.line));

// What a file does that the rule forbids, as `line N: text`
export function violations(file: string, text: string): string[] {
  const out: string[] = [];
  for (const { line, n } of code(text)) {
    if (/file:\/\//.test(line)) out.push(`${file} line ${n}: builds a file:// URL: ${line}`);
    if (LIBRARY_PATH_NAMES.test(line) && !ALLOWED.some((a) => a.file === file && line.includes(a.line))) {
      out.push(`${file} line ${n}: names the library folder: ${line}`);
    }
  }
  return out;
}

test('the old coverUrl, which joined a book and a file onto the library path as a file:// URL, is caught', () => {
  const old = [
    'let libraryDirPath = \'\';',
    'function coverUrl(meta) {',
    '  if (/^[a-z]+:\\/\\//.test(libraryDirPath)) {',
    '    return libraryDirPath + \'/\' + encodeURIComponent(meta.id) + \'/\' + encodeURIComponent(meta.coverImage);',
    '  }',
    '  const p = (libraryDirPath + \'/\' + meta.id + \'/\' + meta.coverImage).replace(/\\\\/g, \'/\');',
    '  return encodeURI(\'file://\' + (p.startsWith(\'/\') ? \'\' : \'/\') + p);',
    '}',
  ].join('\n');
  const found = violations('app/shelf.js', old);
  assert.equal(found.filter((f) => /file:\/\//.test(f) && /builds a file/.test(f)).length, 1);
  assert.equal(found.filter((f) => /names the library folder/.test(f)).length, 3, 'the scheme test and both joins onto the folder');
});

test('a join onto the library path in any renderer file, and a comment that only mentions it, are told apart', () => {
  assert.equal(violations('app/x.js', "const f = path.join(window.libraryPath, 'book.json');").length, 1);
  assert.equal(violations('app/x.js', "const u = `file:///${a}`;").length, 1);
  assert.deepEqual(violations('app/x.js', '// libraryDirPath was a file:// URL once'), []);
  assert.deepEqual(violations('app/x.js', 'const coverUrl = (meta) => `data:${meta.mime};base64,${meta.base64}`;'), []);
});

test('no file of the window or the plugin host builds a file:// URL or names the library folder, beyond the list above', () => {
  const found = RENDERER_FILES.flatMap((file) => violations(file, read(file)));
  assert.deepEqual(found, []);
});

test('every line on the list is still there, so the list cannot hold a line that no longer exists', () => {
  for (const a of ALLOWED.filter((x) => x.why !== 'comment')) {
    assert.ok(read(a.file).includes(a.line), `${a.file}: ${a.line}`);
  }
});
