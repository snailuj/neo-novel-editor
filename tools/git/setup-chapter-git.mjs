#!/usr/bin/env node
// Sets git up to show and merge Neo chapter files one paragraph per line.
// The files themselves stay the compact HTML Neo writes.
//
//   node setup-chapter-git.mjs                       print what to run, change nothing
//   node setup-chapter-git.mjs --apply --global      set it in your global git config
//   node setup-chapter-git.mjs --apply --repo <path> set it in one repo's own config
//
// git keeps driver commands in config, never in a repo, so this has to run
// on each machine (once, with --global). It never edits .gitattributes: it
// prints the lines for the library repo, which belong in a tracked
// .gitattributes at the repo's root, or in .git/info/attributes.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join('/');

// -text: without it core.autocrlf turns a newline inside a chapter into CRLF
// on checkout and the file git holds is no longer the one Neo wrote.
export const ATTRIBUTES = 'book-*/chapters/*.html diff=neochapter merge=neochapter -text';

// Absolute and quoted: the library folder is usually "NEO Library", and a
// repo-relative path is missing when git checks out the first chapter.
export const settings = (dir = toolsDir) => [
  ['diff.neochapter.textconv', `node "${dir}/neo-textconv.js"`],
  ['diff.neochapter.cachetextconv', 'true'],
  ['merge.neochapter.name', 'Neo chapter, merged by paragraph'],
  ['merge.neochapter.driver', `node "${dir}/neo-merge.js" %O %A %B`]
];

const USAGE = `usage: node setup-chapter-git.mjs [--apply (--global | --repo <path>)]
  no options    print the git config commands and the .gitattributes lines; change nothing
  --apply --global       set the drivers in your global git config
  --apply --repo <path>  set the drivers in that repo's own config
`;

const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

function parse(argv) {
  const opts = { apply: false, global: false, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--global') opts.global = true;
    else if (arg === '--repo') {
      opts.repo = argv[++i];
      if (!opts.repo) return { error: '--repo needs a path' };
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else return { error: `unknown option ${arg}` };
  }
  if (opts.help) return opts;
  if ((opts.global || opts.repo) && !opts.apply) return { error: '--global and --repo only work with --apply' };
  if (opts.apply && opts.global === !!opts.repo) return { error: '--apply needs exactly one of --global and --repo <path>' };
  return opts;
}

const git = (args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true });

function printPlan() {
  const lines = [
    'Nothing has been changed. To see chapter diffs, logs and blame one paragraph per line,',
    'and to merge edits to different paragraphs of one chapter, set these once per machine',
    '(bash syntax; in PowerShell run this script with --apply instead):',
    ''
  ];
  for (const [key, value] of settings()) lines.push(`  git config --global ${key} ${shellQuote(value)}`);
  lines.push('', 'or set them for one repo only with --apply --repo <path>. Then, in the library repo,',
    'add this line to its .gitattributes (it covers every book\'s chapters):', '', ATTRIBUTES, '');
  process.stdout.write(lines.join('\n') + '\n');
}

function apply(opts) {
  let scope;
  if (opts.global) scope = ['config', '--global'];
  else {
    const root = git(['-C', opts.repo, 'rev-parse', '--git-dir']);
    if (root.status !== 0) {
      process.stderr.write(`${opts.repo} is not a git repo\n`);
      return 1;
    }
    scope = ['-C', opts.repo, 'config', '--local'];
  }
  for (const [key, value] of settings()) {
    const r = git([...scope, key, value]);
    if (r.status !== 0) {
      process.stderr.write(`git config ${key} failed: ${r.stderr}`);
      return 1;
    }
    process.stdout.write(`set ${key}\n`);
  }
  process.stdout.write(`\nAdd this line to the library repo's .gitattributes:\n\n${ATTRIBUTES}\n`);
  return 0;
}

function main(argv) {
  const opts = parse(argv);
  if (opts.error) {
    process.stderr.write(`${opts.error}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!opts.apply) {
    printPlan();
    return 0;
  }
  return apply(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
