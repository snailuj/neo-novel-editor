// electron-builder's afterPack hook: the last look at a package before it is signed and
// wrapped in an installer. The owner's private writing must never ship, so this reads what
// was packed and fails the build on anything tools/stray-files.cjs says does not belong. A
// package it cannot read is a failure too: an unchecked package must not pass.
//
// Three places are read:
//  - app.asar, by its header, and app.asar.unpacked: every file must be tracked by git.
//    Paths there are the app's own (`main.js`, `node_modules/...`).
//  - the rest of the resources folder (extraResources, and whatever electron-builder or
//    Electron write there, such as app-update.yml): the writing markers only, since none of
//    it has a tracked counterpart to compare with. Paths there are relative to resources.
//  - the project, for the sources that copy a folder into the package as it stands. A
//    link in node_modules (dictionary-hu is `file:dictionaries/hu`) and an extraResources
//    `from` are copied whole, so an untracked file in either ships and looks like part of
//    node_modules or of a licences folder. The sources are checked for untracked files.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { findMarked, findStrays } = require('./stray-files.cjs');

const OUTSIDE_PACKAGE = 'symbolic link points outside the package';
const OUTSIDE_PROJECT = 'symbolic link resolves outside the project';
const UNRESOLVED = 'symbolic link does not resolve';
const UNTRACKED_SOURCE = 'untracked file in a folder that is copied into the package';
const NESTED_REPO = 'nested git repository: its files are not tracked by this project';

function resourcesDir({ appOutDir, electronPlatformName, packager }) {
  return electronPlatformName === 'darwin' || electronPlatformName === 'mas'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
}

// Only ENOENT means absent. fs.existsSync answers false for EPERM and EACCES as well, which
// would pass a folder the hook was not allowed to look into.
function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// -z keeps git from quoting names with spaces or accents.
function git(projectDir, args, what) {
  try {
    const out = execFileSync('git', args, {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\0').filter(Boolean);
  } catch (err) {
    const why = String(err.stderr || err.message).trim();
    throw new Error(`Packaging check: cannot ${what} with git in ${projectDir}: ${why}`);
  }
}

const trackedFiles = (projectDir) => git(projectDir, ['ls-files', '-z'], 'read the tracked files');

// The header tells folders (files), links (link) and files apart; a path list cannot.
function readAsar(archive) {
  if (!exists(archive)) {
    throw new Error(`Packaging check: ${archive} is missing, so the package cannot be checked`);
  }
  let header;
  try {
    header = asar.getRawHeader(archive).header;
    if (!header || typeof header.files !== 'object') throw new Error('no file table in the header');
  } catch (err) {
    throw new Error(`Packaging check: cannot read ${archive}: ${err.message}`);
  }
  const files = [];
  const links = [];
  const pending = [['', header]];
  while (pending.length) {
    const [prefix, folder] = pending.pop();
    for (const [name, node] of Object.entries(folder.files)) {
      const file = prefix + name;
      if (node.files) {
        pending.push([`${file}/`, node]);
        continue;
      }
      files.push(file);
      if (typeof node.link === 'string') links.push({ path: file, problem: archiveLinkProblem(node.link) });
    }
  }
  return { files, links };
}

// Never follows a link: one pointing at a library or vault would be read as part of the
// package. A link is reported by name, and flagged when it resolves outside `root`.
// `skip` names top-level entries to leave out.
function walkTree(dir, root, skip = []) {
  const files = [];
  const links = [];
  if (!exists(dir)) return { files, links };
  const pending = [''];
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of fs.readdirSync(path.join(dir, folder), { withFileTypes: true })) {
      if (!folder && skip.includes(entry.name)) continue;
      const file = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        links.push({ path: file, problem: diskLinkProblem(path.join(dir, file), root) });
        files.push(file);
      } else if (entry.isDirectory()) {
        pending.push(file);
      } else {
        files.push(file);
      }
    }
  }
  return { files, links };
}

// asar stores a link's target relative to the archive root, with the OS separator. The
// pinned version refuses to pack a target outside the archive; this holds if that changes.
function archiveLinkProblem(target) {
  const slashed = target.replace(/\\/g, '/');
  const absolute = path.posix.isAbsolute(slashed) || /^[a-z]:/i.test(slashed);
  const parent = /^\.\.(?:\/|$)/.test(path.posix.normalize(slashed));
  return absolute || parent ? OUTSIDE_PACKAGE : null;
}

// `target` relative to `base` with forward slashes, or null when it is not inside it.
function within(base, target) {
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// A link's target, or null with a stray recorded when it does not resolve or leaves the project.
function resolveLink(full, shown, projectReal, strays) {
  let target;
  try {
    target = fs.realpathSync(full);
  } catch {
    strays.push({ path: shown, reason: UNRESOLVED });
    return null;
  }
  if (within(projectReal, target) === null) {
    strays.push({ path: shown, reason: OUTSIDE_PROJECT });
    return null;
  }
  return target;
}

function diskLinkProblem(link, root) {
  try {
    return within(root, fs.realpathSync(link)) === null ? OUTSIDE_PACKAGE : null;
  } catch {
    // a link that does not resolve cannot be shown to stay inside
    return UNRESOLVED;
  }
}

// Packages the project links to, as folders to check. A link resolving outside the project
// is a stray itself: its contents cannot be vouched for, and it is not followed.
function linkedPackages(projectDir, projectReal, folders, strays) {
  const modules = path.join(projectDir, 'node_modules');
  if (!exists(modules)) return;
  const modulesReal = fs.realpathSync(modules);
  if (within(projectReal, modulesReal) === null) {
    strays.push({ path: 'node_modules', reason: OUTSIDE_PROJECT });
    return;
  }
  const entries = [];
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const sub of fs.readdirSync(path.join(modules, entry.name), { withFileTypes: true })) {
        entries.push([`${entry.name}/${sub.name}`, sub]);
      }
    } else {
      entries.push([entry.name, entry]);
    }
  }
  for (const [name, entry] of entries) {
    if (!entry.isSymbolicLink()) continue;
    const shown = `node_modules/${name}`;
    let target;
    try {
      target = fs.realpathSync(path.join(modules, name));
    } catch {
      strays.push({ path: shown, reason: UNRESOLVED });
      continue;
    }
    const inProject = within(projectReal, target);
    if (inProject === null) strays.push({ path: shown, reason: OUTSIDE_PROJECT });
    // a link into node_modules itself (pnpm's store) is covered by the package rules
    else if (within(modulesReal, target) === null) folders.add(inProject);
  }
}

// electron-builder copies what a link points at as plain files wherever the link sits
// (node_modules/jszip/notes, plugins/tool), so the package shows no link, and only the
// markers and the tracked-file rule would see the names that came through it. A symlink a
// checkout tracks passes the tracked-file rule as a name too. Every packed path is therefore
// walked from the project root, one component at a time, with lstat. A link is resolved,
// never read through blindly: it is a stray when it leaves the project, a folder to check
// against the tracked list when it stays inside the project, and fine inside node_modules.
// The walk goes on from where a link lands, so a link inside a linked package is found too.
// Each path component is looked at once, so the cost follows the packed files.
//
// A packed path need not exist at the same place in the project. electron-builder copies each
// production dependency from where the dependency tree puts it and writes it at
// node_modules/<name>: electron-updater's own fs-extra, say, is packed at the top level
// while the project has it under node_modules/electron-updater/node_modules, and the top
// level may hold a different version of the same name. So a packed package is walked at every
// project folder it can have come from (the same place when its version matches, and each
// copy of that name and version in the lock file), and a link in any of them counts. A packed
// path with no such folder fails the check: there is nothing to compare it with. The one
// legitimate case is a file an extraResources entry (or a files entry with a `to`) put there,
// whose source folder is checked on its own; those are counted, not ignored.
const ABSENT = Symbol('absent');
const NOT_FOUND = 'cannot check: no copy of it was found in the project to compare it with';

// 'node_modules/a/node_modules/@s/b/lib/x.js' is lib/x.js of the package folder
// 'node_modules/a/node_modules/@s/b'; a file directly in node_modules has no package.
function packageOf(file) {
  const parts = file.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || parts[at + 1] === undefined) return null;
  const size = parts[at + 1].startsWith('@') ? 2 : 1;
  if (parts.length <= at + 1 + size) return null;
  return {
    root: parts.slice(0, at + 1 + size).join('/'),
    name: parts.slice(at + 1, at + 1 + size).join('/'),
    rest: parts.slice(at + 1 + size).join('/'),
  };
}

function versionOf(text) {
  try {
    const { version } = JSON.parse(text);
    return typeof version === 'string' ? version : null;
  } catch {
    return null; // no version to match on: the same place is still tried
  }
}

// every lock-file install path of each name@version, e.g. 'fs-extra@10.1.0'
function lockCopies(packages) {
  const copies = new Map();
  for (const [key, entry] of Object.entries(packages)) {
    const at = key.lastIndexOf('node_modules/');
    if (at < 0 || !entry || typeof entry.version !== 'string') continue;
    const id = `${key.slice(at + 'node_modules/'.length)}@${entry.version}`;
    copies.set(id, [...(copies.get(id) ?? []), key]);
  }
  return copies;
}

function packedSources(ctx, files, folders, strays) {
  const { projectDir, projectReal, modulesReal, archive, copies, destinations } = ctx;
  const landed = new Map();

  // where a walk continues from `full`; ABSENT when it is not there, null when a link was
  // reported or leaves nothing more to look at
  const classify = (full, shown) => {
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch (err) {
      if (err.code === 'ENOENT') return ABSENT;
      throw err;
    }
    if (!stat.isSymbolicLink()) return full;
    const target = resolveLink(full, shown, projectReal, strays);
    if (target !== null && (modulesReal === null || within(modulesReal, target) === null)) {
      folders.add(within(projectReal, target));
    }
    return target;
  };

  // false when a component of `rel` is not in the project
  const walk = (rel) => {
    let at = projectDir;
    let shown = '';
    for (const name of rel.split('/')) {
      const full = path.join(at, name);
      shown = shown ? `${shown}/${name}` : name;
      if (!landed.has(full)) landed.set(full, classify(full, shown));
      at = landed.get(full);
      if (at === ABSENT) return false;
      if (at === null) return true;
    }
    return true;
  };

  const sourcesOf = ({ root, name }) => {
    let packed = null;
    try {
      packed = versionOf(asar.extractFile(archive, path.normalize(`${root}/package.json`)).toString('utf8'));
    } catch {
      packed = null; // not packed, or an extraResources file: the same place is still tried
    }
    const found = new Set();
    if (exists(path.join(projectDir, root))) {
      let here = null;
      try {
        here = versionOf(fs.readFileSync(path.join(projectDir, root, 'package.json'), 'utf8'));
      } catch {
        here = null;
      }
      if (packed === null || here === null || here === packed) found.add(root);
    }
    if (packed !== null) for (const copy of copies.get(`${name}@${packed}`) ?? []) found.add(copy);
    return [...found];
  };

  const roots = new Map();
  const unplaced = new Set();
  let relocated = 0;
  let extra = 0;
  for (const file of files) {
    const pkg = packageOf(file);
    let reached = false;
    if (pkg === null) {
      reached = walk(file);
    } else {
      if (!roots.has(pkg.root)) roots.set(pkg.root, sourcesOf(pkg));
      const sources = roots.get(pkg.root);
      for (const source of sources) if (walk(`${source}/${pkg.rest}`)) reached = true;
      if (reached && !sources.includes(pkg.root)) relocated++;
    }
    if (reached) continue;
    if (destinations.some((to) => file === to || file.startsWith(`${to}/`))) extra++;
    else unplaced.add(pkg === null ? file : pkg.root);
  }
  for (const item of unplaced) strays.push({ path: item, reason: NOT_FOUND });
  return { relocated, extra };
}

// package-lock.json: every installed package with its path, and the links among them.
function readLock(projectDir) {
  const file = path.join(projectDir, 'package-lock.json');
  if (!exists(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).packages ?? {};
  } catch (err) {
    throw new Error(`Packaging check: cannot read package-lock.json: ${err.message}`);
  }
}

// `file:` dependencies carry `link: true` and the folder they resolve to.
function lockedLinks(projectDir, packages, folders, strays) {
  for (const [name, entry] of Object.entries(packages)) {
    if (entry && entry.link === true) addSource(projectDir, name, entry.resolved, folders, strays);
  }
}

// Where files come into the package from a folder of the project: extraResources and
// extraFiles entries (a path, or { from, to }), and `files` sets that name a `from` (a glob
// string, or a set with no `from`, names no folder). Read from the build config and the
// platform's own section, as a list or a single entry. Both sections must be there:
// electron-builder is a caret range, and a renamed field read as "no extraResources" would
// turn this check off without an error.
function extraSources(packager) {
  const found = [];
  for (const field of ['config', 'platformSpecificBuildOptions']) {
    const section = packager[field];
    if (section === null || typeof section !== 'object') {
      throw new Error(`Packaging check: cannot check extraResources: packager.${field} is not an object`);
    }
    for (const label of ['extraResources', 'extraFiles', 'files']) {
      const value = section[label];
      if (value == null) continue;
      for (const set of Array.isArray(value) ? value : [value]) {
        const from = typeof set === 'string' ? set : set && set.from;
        if (label === 'files' && (typeof set === 'string' || !from)) continue;
        found.push({ label, from, to: set && typeof set.to === 'string' ? set.to : null });
      }
    }
  }
  return found;
}

// Packed paths (relative to the app) that these entries put there from their sources:
// extraResources into app.asar.unpacked, and a files set's `to` inside the archive.
function destinationsOf(sources) {
  const found = [];
  for (const { label, to } of sources) {
    if (to === null || label === 'extraFiles') continue;
    const dest = to.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
    if (label === 'files') found.push(dest);
    else if (dest.startsWith('app.asar.unpacked/')) found.push(dest.slice('app.asar.unpacked/'.length));
  }
  return found;
}

function addSource(projectDir, label, from, folders, strays) {
  if (typeof from !== 'string' || !from) {
    throw new Error(`Packaging check: cannot check ${label}: it names no source folder`);
  }
  // electron-builder macros (${arch}, ${os}) are only known to it
  if (from.includes('${')) {
    throw new Error(`Packaging check: cannot check ${label} "${from}": its source uses a macro`);
  }
  const inProject = within(projectDir, path.resolve(projectDir, from));
  if (inProject === null) strays.push({ path: from, reason: `${label} source is outside the project` });
  else if (inProject === '') {
    throw new Error(`Packaging check: cannot check ${label} "${from}": its source is the whole project`);
  } else folders.add(inProject);
}

// The files in each source folder, read from disk without following a link, must all be in
// the tracked list. `git ls-files --others` cannot do this: it reports nothing for what is
// inside a nested repository, such as an Obsidian vault that is a repository of its own. A
// link inside a source is followed as packedLinks follows one, and a folder holding a .git
// is a nested repository, named once instead of file by file. Git-ignored files are not
// tracked, so they are strays too: they are copied like any other.
function untrackedIn(projectDir, projectReal, modulesReal, folders, tracked, strays) {
  const known = new Set(tracked);
  const pending = [...folders];
  const done = new Set();
  while (pending.length) {
    const rel = pending.pop();
    if (done.has(rel)) continue;
    done.add(rel);
    const full = path.join(projectDir, rel);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      const target = resolveLink(full, rel, projectReal, strays);
      if (target !== null && (modulesReal === null || within(modulesReal, target) === null)) {
        pending.push(within(projectReal, target));
      }
    } else if (!stat.isDirectory()) {
      if (!known.has(rel)) strays.push({ path: rel, reason: UNTRACKED_SOURCE });
    } else {
      const entries = fs.readdirSync(full, { withFileTypes: true });
      if (entries.some((entry) => entry.name === '.git')) strays.push({ path: rel, reason: NESTED_REPO });
      else for (const entry of entries) pending.push(`${rel}/${entry.name}`);
    }
  }
}

// Strays among the project's own sources: links, the folders whose files must all be
// tracked, and packed paths with no source. Also how many packed paths came from another
// copy than the one at their path, and how many from an extraResources or files entry.
function checkSources(context, files, tracked, archive) {
  const { projectDir } = context.packager;
  const projectReal = fs.realpathSync(projectDir);
  const modules = path.join(projectDir, 'node_modules');
  const modulesReal = exists(modules) ? fs.realpathSync(modules) : null;
  const folders = new Set();
  const strays = [];
  const packages = readLock(projectDir);
  const sources = extraSources(context.packager);
  linkedPackages(projectDir, projectReal, folders, strays);
  if (packages) lockedLinks(projectDir, packages, folders, strays);
  for (const { label, from } of sources) addSource(projectDir, label, from, folders, strays);
  const found = packedSources(
    {
      projectDir,
      projectReal,
      modulesReal,
      archive,
      copies: lockCopies(packages ?? {}),
      destinations: destinationsOf(sources),
    },
    files,
    folders,
    strays,
  );
  untrackedIn(projectDir, projectReal, modulesReal, folders, tracked, strays);
  return { strays, ...found };
}

module.exports = async function afterPack(context) {
  const start = performance.now();
  const resources = resourcesDir(context);
  const archive = path.join(resources, 'app.asar');
  const packed = readAsar(archive);
  const resourcesReal = fs.realpathSync(resources);
  const unpacked = walkTree(path.join(resources, 'app.asar.unpacked'), resourcesReal);
  const other = walkTree(resources, resourcesReal, ['app.asar', 'app.asar.unpacked']);
  const tracked = trackedFiles(context.packager.projectDir);

  const files = [...new Set([...packed.files, ...unpacked.files])];
  const strays = [...findStrays(files, tracked), ...findMarked(other.files)];
  for (const link of [...packed.links, ...unpacked.links, ...other.links]) {
    if (link.problem) strays.push({ path: link.path, reason: link.problem });
  }
  const sources = checkSources(context, files, tracked, archive);
  strays.push(...sources.strays);
  // one line per path and reason: a link can be found by more than one of the checks
  const found = [...new Map(strays.map((s) => [`${s.path}\0${s.reason}`, s])).values()];
  if (found.length) {
    const lines = found.map((s) => `  ${s.path}: ${s.reason}`);
    throw new Error(`Packaging check: ${found.length} stray file(s) in ${resources}\n${lines.join('\n')}`);
  }
  console.log(JSON.stringify({
    event: 'pack.check',
    platform: context.electronPlatformName,
    checked: files.length + other.files.length,
    asar: packed.files.length,
    unpacked: unpacked.files.length,
    other: other.files.length,
    relocated: sources.relocated,
    extra: sources.extra,
    tracked: tracked.length,
    ms: Math.round(performance.now() - start),
  }));
};
