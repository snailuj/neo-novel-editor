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

// --others without --exclude-standard lists git-ignored files too, which is the point: an
// ignored file in a source folder is copied like any other.
const untrackedFiles = (projectDir, folders) =>
  git(projectDir, ['ls-files', '-z', '--others', '--', ...folders], 'list the untracked files');

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

// package-lock.json names the same links: `file:` dependencies carry `link: true` and the
// folder they resolve to.
function lockedLinks(projectDir, folders, strays) {
  const file = path.join(projectDir, 'package-lock.json');
  if (!exists(file)) return;
  let packages;
  try {
    packages = JSON.parse(fs.readFileSync(file, 'utf8')).packages ?? {};
  } catch (err) {
    throw new Error(`Packaging check: cannot read package-lock.json: ${err.message}`);
  }
  for (const [name, entry] of Object.entries(packages)) {
    if (entry && entry.link === true) addSource(projectDir, name, entry.resolved, folders, strays);
  }
}

// extraResources and extraFiles, from the build config and the platform's own section. An
// entry is a path or { from, to }; a list or a single one.
function extraSources(packager) {
  const found = [];
  for (const section of [packager.config, packager.platformSpecificBuildOptions]) {
    for (const key of ['extraResources', 'extraFiles']) {
      const value = section && section[key];
      if (value == null) continue;
      for (const set of Array.isArray(value) ? value : [value]) {
        found.push([key, typeof set === 'string' ? set : set && set.from]);
      }
    }
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
  else folders.add(inProject);
}

// Strays among the project's own sources, and the folders whose untracked files are strays.
function checkSources(context) {
  const { projectDir } = context.packager;
  const folders = new Set();
  const strays = [];
  linkedPackages(projectDir, fs.realpathSync(projectDir), folders, strays);
  lockedLinks(projectDir, folders, strays);
  for (const [label, from] of extraSources(context.packager)) addSource(projectDir, label, from, folders, strays);
  if (folders.size) {
    for (const file of untrackedFiles(projectDir, [...folders])) strays.push({ path: file, reason: UNTRACKED_SOURCE });
  }
  return strays;
}

module.exports = async function afterPack(context) {
  const start = performance.now();
  const resources = resourcesDir(context);
  const packed = readAsar(path.join(resources, 'app.asar'));
  const resourcesReal = fs.realpathSync(resources);
  const unpacked = walkTree(path.join(resources, 'app.asar.unpacked'), resourcesReal);
  const other = walkTree(resources, resourcesReal, ['app.asar', 'app.asar.unpacked']);
  const tracked = trackedFiles(context.packager.projectDir);

  const files = [...new Set([...packed.files, ...unpacked.files])];
  const strays = [...findStrays(files, tracked), ...findMarked(other.files)];
  for (const link of [...packed.links, ...unpacked.links, ...other.links]) {
    if (link.problem) strays.push({ path: link.path, reason: link.problem });
  }
  strays.push(...checkSources(context));
  if (strays.length) {
    const lines = strays.map((s) => `  ${s.path}: ${s.reason}`);
    throw new Error(`Packaging check: ${strays.length} stray file(s) in ${resources}\n${lines.join('\n')}`);
  }
  console.log(JSON.stringify({
    event: 'pack.check',
    platform: context.electronPlatformName,
    checked: files.length + other.files.length,
    asar: packed.files.length,
    unpacked: unpacked.files.length,
    other: other.files.length,
    tracked: tracked.length,
    ms: Math.round(performance.now() - start),
  }));
};
