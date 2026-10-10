// electron-builder's afterPack hook: the last look at a package before it is signed and
// wrapped in an installer. The owner's private writing must never ship, so this reads what
// was packed (app.asar and app.asar.unpacked, not the source tree) and fails the build on
// anything tools/stray-files.cjs says does not belong. A package it cannot read is a
// failure too: an unchecked package must not pass.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { findStrays } = require('./stray-files.cjs');

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
function trackedFiles(projectDir) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: projectDir,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\0').filter(Boolean);
  } catch (err) {
    const why = String(err.stderr || err.message).trim();
    throw new Error(`Packaging check: cannot read the tracked files with git in ${projectDir}: ${why}`);
  }
}

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
      // asar stores a link's target relative to the archive root
      if (typeof node.link === 'string') links.push({ path: file, leaves: /^\.\.(?:\/|$)/.test(path.posix.normalize(node.link)) });
    }
  }
  return { files, links };
}

// Never follows a link: one pointing at a library or vault would be read as part of the
// package. A link is reported by name, and flagged when it resolves outside `root`.
function walkUnpacked(dir, root) {
  const files = [];
  const links = [];
  if (!exists(dir)) return { files, links };
  const pending = [''];
  while (pending.length) {
    const folder = pending.pop();
    for (const entry of fs.readdirSync(path.join(dir, folder), { withFileTypes: true })) {
      const file = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        links.push({ path: file, leaves: leavesRoot(path.join(dir, file), root) });
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

function leavesRoot(link, root) {
  try {
    const rel = path.relative(root, fs.realpathSync(link));
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  } catch {
    return true; // a link that does not resolve cannot be shown to stay inside
  }
}

module.exports = async function afterPack(context) {
  const start = performance.now();
  const resources = resourcesDir(context);
  const packed = readAsar(path.join(resources, 'app.asar'));
  const unpacked = walkUnpacked(path.join(resources, 'app.asar.unpacked'), fs.realpathSync(resources));
  const tracked = trackedFiles(context.packager.projectDir);

  const checked = [...new Set([...packed.files, ...unpacked.files])];
  const strays = findStrays(checked, tracked);
  for (const link of [...packed.links, ...unpacked.links]) {
    if (link.leaves) strays.push({ path: link.path, reason: 'symbolic link points outside the package' });
  }
  if (strays.length) {
    const lines = strays.map((s) => `  ${s.path}: ${s.reason}`);
    throw new Error(`Packaging check: ${strays.length} stray file(s) in ${resources}\n${lines.join('\n')}`);
  }
  console.log(JSON.stringify({
    event: 'pack.check',
    platform: context.electronPlatformName,
    checked: checked.length,
    asar: packed.files.length,
    unpacked: unpacked.files.length,
    tracked: tracked.length,
    ms: Math.round(performance.now() - start),
  }));
};
