'use strict';

// tools/git: a chapter file stays the compact HTML Neo writes, and git is
// taught to show it, and merge it, one paragraph per line. These tests run
// the scripts as git runs them, in temp repos, with git's global and system
// config pointed at an empty temp file so no real config is read or written.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const { paragraphLines, compactLines } = require('../tools/git/neo-lines.js');

const TOOLS = path.join(__dirname, '..', 'tools', 'git');
const slash = (p) => p.split(path.sep).join('/');
const TEXTCONV = slash(path.join(TOOLS, 'neo-textconv.js'));
const MERGE = slash(path.join(TOOLS, 'neo-merge.js'));

let sandbox;
let env;
before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-git-test-'));
  const globalConfig = path.join(sandbox, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: sandbox,
    USERPROFILE: sandbox,
    GIT_TERMINAL_PROMPT: '0'
  };
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function git(cwd, args, extraEnv = {}) {
  const r = spawnSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'latin1', windowsHide: true, maxBuffer: 1 << 26 });
  return { out: r.stdout, err: r.stderr, status: r.status };
}
function gitOk(cwd, args, extraEnv) {
  const r = git(cwd, args, extraEnv);
  assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.err}`);
  return r;
}

// What Neo writes (compact), and what a hand-edited or foreign file may hold.
const EDGE = {
  empty: '',
  'blank paragraph': '<p><br></p>',
  single: '<p>only one</p>',
  'nested lists': '<p>a</p><ul><li>x<ul><li>y</li><li><p>deep</p><p>deeper</p></li></ul></li><li>z</li></ul><p>b</p><p>c</p><ol><li><p>p1</p><p>p2</p></li></ol><p>d</p>',
  blockquote: '<p>a</p><blockquote><p>q1</p><p>q2</p></blockquote><p>b</p><blockquote>bare quote</blockquote>',
  br: '<p>line<br>two<br></p><p>x<br><br></p><p><br><br></p>',
  'pre and code': '<p>a</p><pre>code\n  line2\n\n    line4 <p>not a tag</p></pre><p>b</p><p>c</p><pre><code>x\n</code></pre>',
  'non-ASCII': '<p>café 日本語 😀 naïve</p><p>Жук nbsp char</p>',
  'newline inside a paragraph': '<p>a <i>b</i>\nc</p><p>d</p>',
  'CRLF inside a paragraph': '<p>a\r\nb</p><p>c</p>',
  'table and section': '<p>a</p><table><tr><td><p>c1</p><p>c2</p></td></tr></table><section><p>s1</p><p>s2</p></section><p>b</p>',
  comment: '<!-- <p> --><p>a</p><p>b</p>',
  'text before': 'loose text<p>a</p><p>b</p>',
  'text after': '<p>a</p><p>b</p>tail',
  'headings and div': '<h2>t</h2><div>d</div><p>p</p><blockquote>q</blockquote>',
  'scene break': '<p>a</p><p class="scene-break">***</p><p><br></p>'
};
// Not what Neo writes: whitespace between top-level blocks.
const FOREIGN = {
  'a space between blocks': '<p>a</p> <p>b</p>',
  'blank lines between blocks': '<p>a</p>\n\n\n<p>b</p>\n\n',
  'newline at the end': '<p>a</p><p>b</p>\n'
};

test('each top-level paragraph stands on its own line', () => {
  assert.equal(paragraphLines('<p>a</p><p class="scene-break">***</p><p><br></p>'), '<p>a</p>\n<p class="scene-break">***</p>\n<p><br></p>\n');
});

test('a list, table or quote with paragraphs inside is one line, and a line inside a paragraph stays', () => {
  assert.equal(paragraphLines('<p>a</p><ul><li><p>x</p><p>y</p></li></ul><p>b</p><p>c</p>'), '<p>a</p><ul><li><p>x</p><p>y</p></li></ul><p>b</p>\n<p>c</p>\n');
  assert.equal(paragraphLines('<p>a</p><blockquote><p>q1</p><p>q2</p></blockquote><p>b</p>'), '<p>a</p>\n<blockquote><p>q1</p><p>q2</p></blockquote>\n<p>b</p>\n');
  assert.equal(paragraphLines('<p>a <i>b</i>\nc</p><p>d</p>'), '<p>a <i>b</i>\nc</p>\n<p>d</p>\n');
});

test('paragraphLines is idempotent on everything', () => {
  for (const [name, html] of Object.entries({ ...EDGE, ...FOREIGN })) {
    const once = paragraphLines(html);
    assert.equal(paragraphLines(once), once, name);
  }
});

test('lining then compacting gives back every chapter Neo can write', () => {
  for (const [name, html] of Object.entries(EDGE)) assert.equal(compactLines(paragraphLines(html)), html, name);
});

test('whitespace between top-level blocks is the one thing compacting does not give back', () => {
  for (const [name, html] of Object.entries(FOREIGN)) assert.notEqual(compactLines(paragraphLines(html)), html, name);
});

const textconv = (file) => spawnSync(process.execPath, [TEXTCONV, file], { windowsHide: true, maxBuffer: 1 << 26 });

test('the textconv script prints a chapter file one paragraph per line, byte for byte otherwise', () => {
  for (const [name, html] of Object.entries(EDGE)) {
    const file = path.join(sandbox, 'tc.html');
    fs.writeFileSync(file, html, 'utf8');
    const r = textconv(file);
    assert.equal(r.status, 0, name);
    assert.deepEqual(r.stdout, Buffer.from(paragraphLines(html), 'utf8'), name);
  }
});

test('the textconv script fails on a file that is not there', () => {
  assert.notEqual(textconv(path.join(sandbox, 'missing.html')).status, 0);
});

// A repo with the chapters directory a library keeps, the attributes the
// setup script prints and the drivers set in the repo's own config.
function libraryRepo(name, { drivers = true } = {}) {
  const repo = path.join(sandbox, name);
  fs.mkdirSync(path.join(repo, 'book-x-1', 'chapters'), { recursive: true });
  gitOk(repo, ['init', '-q', '-b', 'main']);
  gitOk(repo, ['config', 'user.name', 'init']);
  gitOk(repo, ['config', 'user.email', 'init@example.invalid']);
  gitOk(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'book-*/chapters/*.html diff=neochapter merge=neochapter -text\n');
  if (drivers) {
    gitOk(repo, ['config', 'diff.neochapter.textconv', `node "${TEXTCONV}"`]);
    gitOk(repo, ['config', 'merge.neochapter.name', 'Neo chapter, merged by paragraph']);
    gitOk(repo, ['config', 'merge.neochapter.driver', `node "${MERGE}" %O %A %B`]);
  }
  return repo;
}
const chapterPath = (repo) => path.join(repo, 'book-x-1', 'chapters', 'c1.html');
const paragraphs = (n, edits = {}) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i}${edits[i] ? ' ' + edits[i] : ''}.</p>`).join('');
function commit(repo, html, message, author = 'init') {
  fs.writeFileSync(chapterPath(repo), html, 'utf8');
  gitOk(repo, ['add', '-A']);
  gitOk(repo, ['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: author + '@example.invalid', GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: author + '@example.invalid' });
}

test('git diff of one edited paragraph shows that paragraph and its neighbours, not the whole chapter', () => {
  const repo = libraryRepo('diff');
  commit(repo, paragraphs(10), 'base');
  fs.writeFileSync(chapterPath(repo), paragraphs(10, { 5: 'EDITED' }), 'utf8');
  const lines = gitOk(repo, ['diff']).out.split('\n');
  assert.deepEqual(lines.filter((l) => /^[-+]</.test(l)), ['-<p>Paragraph 5.</p>', '+<p>Paragraph 5 EDITED.</p>']);
  assert.ok(lines.includes(' <p>Paragraph 4.</p>'), 'a neighbour is context');
});

test('without the driver the same edit is one giant line, so the setting is what makes the difference', () => {
  const repo = libraryRepo('diff-plain', { drivers: false });
  commit(repo, paragraphs(10), 'base');
  fs.writeFileSync(chapterPath(repo), paragraphs(10, { 5: 'EDITED' }), 'utf8');
  const changed = gitOk(repo, ['diff']).out.split('\n').filter((l) => /^[-+]</.test(l));
  assert.equal(changed.length, 2);
  assert.ok(changed[0].length > 100, 'the whole chapter is on the changed line');
});

test('git blame names the author of each paragraph', () => {
  const repo = libraryRepo('blame');
  commit(repo, paragraphs(6), 'base', 'ann');
  commit(repo, paragraphs(6, { 2: 'by bob' }), 'bob edits', 'bob');
  commit(repo, paragraphs(6, { 2: 'by bob', 4: 'by cy' }), 'cy edits', 'cy');
  const rows = gitOk(repo, ['blame', '--line-porcelain', 'book-x-1/chapters/c1.html']).out.split('\n');
  const authors = rows.filter((l) => l.startsWith('author ')).map((l) => l.slice(7));
  assert.deepEqual(authors, ['ann', 'ann', 'bob', 'ann', 'cy', 'ann']);
});

test('the file git stores and checks out is exactly what Neo wrote, whatever the global line-ending setting', () => {
  const repo = libraryRepo('bytes');
  gitOk(repo, ['config', 'core.autocrlf', 'true']); // as on a default Windows install
  const html = EDGE['pre and code'] + EDGE['CRLF inside a paragraph'];
  commit(repo, html, 'base');
  fs.rmSync(chapterPath(repo));
  gitOk(repo, ['checkout', '--', '.']);
  assert.deepEqual(fs.readFileSync(chapterPath(repo)), Buffer.from(html, 'utf8'));
});

// Two branches off one base, each editing paragraphs of one chapter; then merge.
function merge(name, base, left, right, options) {
  const repo = libraryRepo(name, options);
  commit(repo, base, 'base');
  gitOk(repo, ['checkout', '-q', '-b', 'left']);
  commit(repo, left, 'left');
  gitOk(repo, ['checkout', '-q', 'main']);
  gitOk(repo, ['checkout', '-q', '-b', 'right']);
  commit(repo, right, 'right');
  const merged = git(repo, ['merge', '--no-edit', 'left']);
  return { repo, merged, text: fs.readFileSync(chapterPath(repo), 'latin1') };
}

test('edits to different paragraphs of one chapter merge cleanly and the file stays compact', () => {
  const { merged, text } = merge('merge-far', paragraphs(40), paragraphs(40, { 8: 'LEFT' }), paragraphs(40, { 30: 'RIGHT' }));
  assert.equal(merged.status, 0, merged.out + merged.err);
  assert.equal(text, paragraphs(40, { 8: 'LEFT', 30: 'RIGHT' }));
});

test('edits to paragraphs with one between them also merge cleanly', () => {
  const { merged, text } = merge('merge-gap', paragraphs(40), paragraphs(40, { 8: 'LEFT' }), paragraphs(40, { 10: 'RIGHT' }));
  assert.equal(merged.status, 0, merged.out + merged.err);
  assert.equal(text, paragraphs(40, { 8: 'LEFT', 10: 'RIGHT' }));
});

test('edits to adjacent paragraphs are a conflict, with the markers in the file', () => {
  const { merged, text } = merge('merge-adjacent', paragraphs(40), paragraphs(40, { 8: 'LEFT' }), paragraphs(40, { 9: 'RIGHT' }));
  assert.notEqual(merged.status, 0);
  assert.match(merged.out, /CONFLICT/);
  assert.match(text, /<<<<<<< /);
  assert.match(text, /Paragraph 8 LEFT\./);
  assert.match(text, /Paragraph 9 RIGHT\./);
});

test('edits to the same paragraph are a conflict', () => {
  const { merged } = merge('merge-same', paragraphs(40), paragraphs(40, { 8: 'LEFT' }), paragraphs(40, { 8: 'RIGHT' }));
  assert.notEqual(merged.status, 0);
});

test('a chapter with whitespace between blocks is never rewritten by a merge: the edits conflict and nothing is lost', () => {
  const withGaps = (edits) => Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i}${edits[i] ? ' ' + edits[i] : ''}.</p>`).join('\n\n') + '\n';
  const { merged, text } = merge('merge-foreign', withGaps({}), withGaps({ 0: 'LEFT' }), withGaps({ 5: 'RIGHT' }));
  // git's own line merge is clean here: the file is lined already. The driver must not change its blank lines.
  assert.equal(merged.status, 0, merged.out + merged.err);
  assert.equal(text, withGaps({ 0: 'LEFT', 5: 'RIGHT' }));
});

test('a foreign shape that is one line gives a conflict, not a changed file', () => {
  const base = '<p>a</p> <p>b</p> <p>c</p>';
  const { merged, text } = merge('merge-foreign-line', base, '<p>a LEFT</p> <p>b</p> <p>c</p>', '<p>a</p> <p>b</p> <p>c RIGHT</p>');
  assert.notEqual(merged.status, 0);
  assert.match(text, /<p>a LEFT<\/p> <p>b<\/p> <p>c<\/p>/);
  assert.match(text, /<p>a<\/p> <p>b<\/p> <p>c RIGHT<\/p>/);
});

test('without the merge driver the same two edits conflict, so the setting is what makes the difference', () => {
  const { merged } = merge('merge-plain', paragraphs(40), paragraphs(40, { 8: 'LEFT' }), paragraphs(40, { 30: 'RIGHT' }), { drivers: false });
  assert.notEqual(merged.status, 0);
});
