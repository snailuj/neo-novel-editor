'use strict';

// tools/git/setup-chapter-git.mjs, run against a temp repo and a temp global
// config only. GIT_CONFIG_GLOBAL points at a file in the sandbox, system
// config is off, and HOME is the sandbox, so the real ~/.gitconfig is never
// read or written.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, before, after } = require('node:test');

const SETUP = path.join(__dirname, '..', 'tools', 'git', 'setup-chapter-git.mjs');
const slash = (p) => p.split(path.sep).join('/');

// git writes a note when it caches a textconv result, and a note needs an identity
const USER_CONFIG = '[user]\n\tname = sandbox\n\temail = sandbox@example.invalid\n';

let sandbox;
let globalConfig;
let env;
before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-setup-test-'));
  globalConfig = path.join(sandbox, 'global.gitconfig');
  fs.writeFileSync(globalConfig, USER_CONFIG);
  env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', HOME: sandbox, USERPROFILE: sandbox, GIT_TERMINAL_PROMPT: '0' };
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const run = (args, script = SETUP) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', windowsHide: true });
const git = (cwd, args) => spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
function newRepo(name) {
  const repo = path.join(sandbox, name);
  fs.mkdirSync(repo, { recursive: true });
  assert.equal(git(repo, ['init', '-q', '-b', 'main']).status, 0);
  return repo;
}
const configOf = (repo) => fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8');
const KEYS = ['diff.neochapter.textconv', 'diff.neochapter.cachetextconv', 'merge.neochapter.name', 'merge.neochapter.driver'];

test('by default it prints the commands and the attributes and changes nothing', () => {
  const repo = newRepo('default');
  const before = [fs.readFileSync(globalConfig, 'utf8'), configOf(repo)];
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  for (const key of KEYS) assert.ok(r.stdout.includes(key), key);
  assert.match(r.stdout, /^book-\*\/chapters\/\*\.html diff=neochapter merge=neochapter -text$/m);
  assert.deepEqual([fs.readFileSync(globalConfig, 'utf8'), configOf(repo)], before);
});

test('the printed script paths are absolute and quoted', () => {
  const r = run([]);
  const tools = slash(path.dirname(SETUP));
  assert.ok(r.stdout.includes(`"${tools}/neo-textconv.js"`), r.stdout);
  assert.ok(r.stdout.includes(`"${tools}/neo-merge.js" %O %A %B`), r.stdout);
  assert.ok(path.isAbsolute(tools));
});

test('--apply --global sets the four keys in the global config', () => {
  const r = run(['--apply', '--global']);
  assert.equal(r.status, 0, r.stderr);
  const got = (key) => git(sandbox, ['config', '--global', '--get', key]).stdout.trim();
  const tools = slash(path.dirname(SETUP));
  assert.equal(got('diff.neochapter.textconv'), `node "${tools}/neo-textconv.js"`);
  assert.equal(got('diff.neochapter.cachetextconv'), 'true');
  assert.ok(got('merge.neochapter.name'));
  assert.equal(got('merge.neochapter.driver'), `node "${tools}/neo-merge.js" %O %A %B`);
  assert.match(fs.readFileSync(globalConfig, 'utf8'), /name = sandbox/, 'the rest of the config is kept');
  assert.match(r.stdout, /^book-\*\/chapters\/\*\.html diff=neochapter merge=neochapter -text$/m, 'it still prints the attributes to add');
});

test('applying twice leaves one value per key', () => {
  run(['--apply', '--global']);
  run(['--apply', '--global']);
  for (const key of KEYS) {
    const values = git(sandbox, ['config', '--global', '--get-all', key]).stdout.trim();
    assert.ok(values, key + ' is set');
    assert.equal(values.split('\n').length, 1, key);
  }
});

test('--apply --repo sets the keys in that repo only', () => {
  const repo = newRepo('repo-apply');
  fs.writeFileSync(globalConfig, USER_CONFIG);
  const r = run(['--apply', '--repo', repo]);
  assert.equal(r.status, 0, r.stderr);
  for (const key of KEYS) assert.ok(git(repo, ['config', '--local', '--get', key]).stdout.trim(), key);
  assert.equal(fs.readFileSync(globalConfig, 'utf8'), USER_CONFIG);
});

test('--apply needs exactly one of --global and --repo, and a repo that is one', () => {
  fs.writeFileSync(globalConfig, USER_CONFIG);
  const plain = path.join(sandbox, 'not-a-repo');
  fs.mkdirSync(plain);
  assert.equal(run(['--help']).status, 0, 'the script exists and runs');
  for (const args of [['--apply'], ['--apply', '--global', '--repo', plain], ['--apply', '--repo'], ['--apply', '--repo', plain], ['--apply', '--repo', path.join(sandbox, 'missing')], ['--bogus']]) {
    const r = run(args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.ok(r.stderr.length > 0, args.join(' '));
  }
  assert.equal(fs.readFileSync(globalConfig, 'utf8'), USER_CONFIG);
  assert.equal(fs.existsSync(path.join(plain, '.git')), false);
});

test('with the tools in a folder whose name has a space, the applied settings still work in git', () => {
  const spaced = path.join(sandbox, 'NEO Tools', 'git');
  fs.mkdirSync(spaced, { recursive: true });
  for (const f of fs.readdirSync(path.dirname(SETUP))) fs.copyFileSync(path.join(path.dirname(SETUP), f), path.join(spaced, f));
  const repo = newRepo('spaced');
  const r = run(['--apply', '--repo', repo], path.join(spaced, 'setup-chapter-git.mjs'));
  assert.equal(r.status, 0, r.stderr);
  fs.mkdirSync(path.join(repo, 'book-x-1', 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitattributes'), 'book-*/chapters/*.html diff=neochapter merge=neochapter -text\n');
  const chapter = path.join(repo, 'book-x-1', 'chapters', 'c1.html');
  const html = (edit) => Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i}${i === 4 ? edit : ''}.</p>`).join('');
  fs.writeFileSync(chapter, html(''));
  git(repo, ['add', '-A']);
  assert.equal(git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base']).status, 0);
  fs.writeFileSync(chapter, html(' EDITED'));
  const changed = git(repo, ['diff']).stdout.split('\n').filter((l) => /^[-+]</.test(l));
  assert.deepEqual(changed, ['-<p>Paragraph 4.</p>', '+<p>Paragraph 4 EDITED.</p>']);
});

test('the printed help says how to compact a chapter left lined, with the absolute script path', () => {
  const r = run([]);
  const tools = slash(path.dirname(SETUP));
  assert.ok(r.stdout.includes(`node "${tools}/neo-compact.js" <library folder>`), r.stdout);
  assert.match(r.stdout, /--write/);
});
