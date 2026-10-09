'use strict';

// Plugins, main-process half. A plugin is a folder holding a plugin.json; the
// folders sit under plugins/ in the app folder and, outside a packaged app,
// under each comma-separated folder in NEO_PLUGIN_DIRS. This file finds them,
// lists them for the window (plugins:list) and puts their commands in a
// Plugins menu. It takes nothing from Electron itself: main.js hands it app,
// ipcMain and logError through wire(), and nothing runs when it is loaded.

const fs = require('fs');
const path = require('path');

// the same rules as schemas/plugin-manifest-v1.json, written out by hand
const MANIFEST_KEYS = ['id', 'apiVersion', 'renderer', 'main', 'style', 'commands'];
const COMMAND_KEYS = ['id', 'title'];
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,31}$/;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.(js|cjs|css)$/;
const MAX_COMMANDS = 16;
const MAX_TITLE = 64;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));
const isFileName = (v) => typeof v === 'string' && FILE_NAME.test(v);
const optionalFile = (v) => v === undefined || isFileName(v);
// a schema's maxLength counts code points, not UTF-16 units
const titleOk = (v) => typeof v === 'string' && v.length > 0 && [...v].length <= MAX_TITLE;

function validManifest(m) {
  if (!isObject(m) || !onlyKeys(m, MANIFEST_KEYS)) return false;
  if (typeof m.id !== 'string' || !PLUGIN_ID.test(m.id)) return false;
  if (!Number.isInteger(m.apiVersion) || m.apiVersion < 1 || m.apiVersion > 2) return false;
  if (!isFileName(m.renderer) || !optionalFile(m.main) || !optionalFile(m.style)) return false;
  if (m.commands === undefined) return true;
  return Array.isArray(m.commands) && m.commands.length <= MAX_COMMANDS && m.commands.every((c) =>
    isObject(c) && onlyKeys(c, COMMAND_KEYS) && typeof c.id === 'string' && titleOk(c.title));
}

let host = null; // { app, ipcMain, logError, appRoot }, from wire()
let found = null; // discover()'s answer, kept for the life of the process

function wire(deps) {
  host = deps;
  found = null;
  // the window asks once, synchronously, before any of its code runs, and
  // waits until it has an answer, so a throw here would hang it. It gets no
  // mainPath: the window never touches the disk, so it needs no paths on it
  host.ipcMain.on('plugins:list', (e) => {
    try {
      e.returnValue = discover().map(({ mainPath, ...listed }) => listed);
    } catch (err) {
      host.logError('plugins', err);
      e.returnValue = [];
    }
  });
}

function skip(folder, why) {
  host.logError('plugins ' + folder, why);
}

// index.html loads a plugin's files by URLs relative to the app folder, and
// the page's CSP ('self') holds only inside that folder
function outsideApp(rel) {
  return path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep);
}

function urlOf(rel, folderName, file) {
  const segments = rel ? rel.split(path.sep) : [];
  return [...segments, folderName, file].map(encodeURIComponent).join('/');
}

// NEO_PLUGIN_DIRS is for development: a packaged app reads only plugins/
function extraRoots() {
  const { app, appRoot } = host;
  if (app.isPackaged || !process.env.NEO_PLUGIN_DIRS) return [];
  return process.env.NEO_PLUGIN_DIRS.split(',').map((dir) => dir.trim()).filter(Boolean)
    .map((dir) => path.resolve(appRoot, dir));
}

function discover() {
  if (found) return found;
  const { appRoot } = host;
  const bundled = path.join(appRoot, 'plugins');
  const byId = new Map();
  const list = [];
  for (const root of [bundled, ...extraRoots()]) {
    // path.relative compares without regard to case on Windows
    const rel = path.relative(appRoot, root);
    if (outsideApp(rel)) { skip(root, 'skipped: outside the app folder'); continue; }
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      // an app without bundled plugins has no plugins/ folder at all
      if (!(err.code === 'ENOENT' && root === bundled)) skip(root, err);
      continue;
    }
    // a link (a symlink, or a junction on Windows) can lead outside the app
    // folder, so it is refused like a root outside it
    for (const e of entries) if (e.isSymbolicLink()) skip(path.join(root, e.name), 'skipped: a link, which can lead outside the app folder');
    for (const name of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const folder = path.join(root, name);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(folder, 'plugin.json'), 'utf8'));
      } catch (err) { skip(folder, err); continue; }
      if (!validManifest(manifest)) { skip(folder, 'skipped: plugin.json does not match the manifest format'); continue; }
      if (byId.has(manifest.id)) { skip(folder, `skipped: the id "${manifest.id}" is already used by ${byId.get(manifest.id)}`); continue; }
      let rendererUrl, styleUrl;
      try {
        // encodeURIComponent throws URIError on a name holding a lone surrogate
        rendererUrl = urlOf(rel, name, manifest.renderer);
        styleUrl = manifest.style ? urlOf(rel, name, manifest.style) : null;
      } catch (err) { skip(folder, err); continue; }
      byId.set(manifest.id, folder);
      list.push({
        ...manifest,
        rendererUrl,
        styleUrl,
        mainPath: manifest.main ? path.join(folder, manifest.main) : null
      });
    }
  }
  found = list;
  return found;
}

// the Plugins menu, or nothing when no plugin declares a command; a click
// goes to the window as { type: 'plugin-command', plugin, command }. main.js
// passes the label through t(), since scripts/i18n.js does not scan this file
function menuItems(send, label = 'Plugins') {
  const submenu = [];
  for (const m of discover()) {
    for (const c of m.commands || []) {
      submenu.push({ label: c.title, click: () => send({ type: 'plugin-command', plugin: m.id, command: c.id }) });
    }
  }
  return submenu.length ? [{ label, submenu }] : [];
}

module.exports = { wire, validManifest, discover, menuItems };
