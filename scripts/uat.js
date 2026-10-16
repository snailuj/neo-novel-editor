#!/usr/bin/env node
'use strict';

// npm run uat -- --vault <folder> [--vault <folder> ...]   build, then open NEO on copies
// npm run uat -- --reset ...                               throw the copies away and copy again
//
// Opens this checkout's NEO (with the hoard plugin built) on copies of your
// library and of the vaults you name, in a folder beside the checkout
// ("NEO UAT"), with its own settings, as npm run try does for a bundle. The
// real library and vaults are only read. The copies are made on the first
// launch and kept after it, so a day of testing can quit and come back;
// --reset copies afresh. The window bar says "(trial copy)".

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = '.neo-uat';
// left out of a vault's copy; the vault's .git only when .obsidian marks its top
const VAULT_SKIP = new Set(['node_modules', '.worktrees', '.trash']);

const inside = (a, b) => {
  const rel = path.relative(path.resolve(b), path.resolve(a));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function copyTree(from, to, skip, counts) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name, from)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    try {
      if (e.isDirectory()) copyTree(a, b, skip, counts);
      else if (e.isFile()) { fs.copyFileSync(a, b); counts.files++; }
    } catch (err) {
      // a file still in iCloud or locked is left out, and said so
      counts.skipped.push(`${a}: ${err.code || err.message}`);
    }
  }
}

function open(home) {
  try {
    const pid = Number(/-(\d+)$/.exec(fs.readlinkSync(path.join(home, 'settings', 'SingletonLock')))[1]);
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
}

/** Makes (or finds) the UAT folder. Reads realLibrary and vaults; writes only under home. */
function prepare({ home, realLibrary, settings, vaults, reset = false, log = () => {} }) {
  const marker = path.join(home, MARKER);
  if (fs.existsSync(home) && !fs.existsSync(marker) && fs.readdirSync(home).length) {
    throw new Error(`There's already a folder at ${home} that the UAT script didn't make. Move it, then try again.`);
  }
  for (const v of vaults) {
    if (inside(v, home) || inside(home, v) || inside(realLibrary, v) || inside(v, realLibrary)) {
      throw new Error(`The vault ${v} is inside the UAT folder or the library, or holds one of them. Name the vault's own folder.`);
    }
  }
  if (reset && fs.existsSync(marker)) {
    if (open(home)) throw new Error('NEO UAT is still open. Quit it, then try again.');
    log('Throwing away the last UAT copies…');
    fs.rmSync(home, { recursive: true, force: true });
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(marker, 'Made by npm run uat. Safe to delete.\n');

  const library = path.join(home, 'NEO Library');
  const counts = { files: 0, skipped: [] };
  let copied = false;
  if (!fs.existsSync(library)) {
    copied = true;
    if (realLibrary && fs.existsSync(path.join(realLibrary, 'library.json'))) {
      log(`Copying your library from ${realLibrary} (the original isn't changed)…`);
      copyTree(realLibrary, library, (name, from) => name === 'Backups' && from === realLibrary, counts);
    } else {
      log('No library found to copy, so UAT starts with an empty one.');
      fs.mkdirSync(library, { recursive: true });
    }
    fs.mkdirSync(path.join(home, 'settings'), { recursive: true });
    fs.writeFileSync(path.join(home, 'settings', 'settings.json'), JSON.stringify({ ...settings, libraryDir: library }, null, 2));
  }

  const made = [];
  const used = new Set();
  for (const v of vaults) {
    let name = path.basename(path.resolve(v)) || 'vault';
    while (used.has(name)) name += '-2';
    used.add(name);
    const to = path.join(home, 'vaults', name);
    made.push(to);
    if (fs.existsSync(to)) continue;
    log(`Copying the vault ${v} to ${to} (the original isn't changed)…`);
    const marked = fs.existsSync(path.join(v, '.obsidian'));
    copyTree(v, to, (n, from) => VAULT_SKIP.has(n) || (n === '.git' && marked && from === v), counts);
  }
  if (counts.skipped.length) log(`${counts.skipped.length} file(s) couldn't be copied and were left out:\n  ${counts.skipped.slice(0, 20).join('\n  ')}`);
  return { library, vaults: made, copied, files: counts.files, skipped: counts.skipped };
}

function main() {
  const stop = (msg) => { console.error('\n✋ ' + msg + '\n'); process.exit(1); };
  const say = (msg) => console.log('→ ' + msg);
  const root = path.join(__dirname, '..');
  const args = process.argv.slice(2);
  const vaults = [];
  let reset = false;
  let home = path.join(root, '..', 'NEO UAT');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reset') reset = true;
    else if (args[i] === '--vault' && args[i + 1]) vaults.push(path.resolve(args[++i]));
    else if (args[i] === '--home' && args[i + 1]) home = path.resolve(args[++i]);
    else stop(`I don't know "${args[i]}". Use --vault <folder>, --reset or --home <folder>.`);
  }
  for (const v of vaults) if (!fs.existsSync(v)) stop(`Can't find the vault ${v}.`);

  // where the real NEO keeps its settings, and so its library
  const userData = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'NEO')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NEO')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'NEO');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')); } catch { /* none yet */ }
  const realLibrary = settings.libraryDir || path.join(os.homedir(), 'Documents', 'NEO Library');

  let made;
  try { made = prepare({ home, realLibrary, settings, vaults, reset, log: say }); } catch (err) { stop(err.message); }
  if (!made.copied) say(`Using the UAT copies already in ${home} (npm run uat -- --reset to copy again).`);
  say(`Library copy: ${made.library}`);
  for (const v of made.vaults) say(`Vault copy:   ${v}`);

  say('Building the plugin…');
  try { execFileSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { cwd: root, stdio: 'inherit' }); } catch {
    stop('The build failed (above). If it says a package is missing, run npm ci first.');
  }
  say('Opening NEO UAT. Its window bar says "(trial copy)". Quit it when you\'re done.');
  const electron = require(path.join(root, 'node_modules', 'electron'));
  // Chromium refuses to run as root (a container) with its sandbox on
  const flags = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
  const child = spawn(electron, ['.', ...flags], { cwd: root, stdio: 'inherit', env: { ...process.env, NEO_TRY_DIR: home } });
  child.on('exit', () => {
    console.log(`\n✅ NEO UAT closed. Your real library and vaults weren't touched. The copies stay in ${home}.`);
    console.log(`   Errors, if any: ${path.join(made.library, 'neo-errors.log')} and ${path.join(home, 'settings', 'neo-errors.log')}\n`);
  });
}

if (require.main === module) main();
module.exports = { prepare };
