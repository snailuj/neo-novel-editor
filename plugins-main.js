'use strict';

// Plugins, main-process half. A plugin is a folder holding a plugin.json; the
// folders sit under plugins/ in the app folder and, outside a packaged app,
// under each comma-separated folder in NEO_PLUGIN_DIRS. This file finds them,
// lists them for the window (plugins:list), puts their commands in a Plugins
// menu, and starts the main half of each plugin that has one (its manifest's
// main): an activate(host) that answers the plugin's own window half
// (plugin:invoke) and hears of each write from the window (afterWrite). It
// takes nothing from Electron itself: main.js hands it app, ipcMain,
// logError, the settings and the library folder through wire(), and nothing
// runs when it is loaded.

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

// { app, ipcMain, logError, appRoot, readSettings, writeSettings,
// libraryDir }, from wire(). readSettings answers {} when there is no
// settings.json yet and throws when it cannot read or parse the one there.
let host = null;
let found = null; // discover()'s answer, kept for the life of the process
// Each started main half by plugin id: { id, ready, failed, handlers,
// listeners }. ready settles once its activate has, and never rejects;
// handlers maps a channel to a function, listeners an event to a Set.
let mains = new Map();

function wire(deps) {
  host = deps;
  found = null;
  mains = new Map();
  failures = new WeakMap();
  // a plugin's window half calls its own main half (neo.invoke in plugins.js)
  host.ipcMain.handle('plugin:invoke', (_e, id, channel, payload) => invoke(id, channel, payload));
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

// A plugin's main half: what its activate(host) receives, the IPC it
// answers, and the events it hears. A plugin reaches only its own half.

const CHANNEL = /^[a-z][a-z0-9.-]{0,63}$/;
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

// What a plugin threw or passed, as one piece of text: an error's stack,
// else JSON. A plugin can throw anything, and a Symbol or an object with no
// prototype has no text form; the line must still be written.
function textOf(what) {
  try {
    if (what && what.stack) return String(what.stack);
    if (typeof what === 'string') return what;
    const json = JSON.stringify(what);
    return json === undefined ? String(what) : json;
  } catch {
    return `(a value of type ${typeof what} with no text form)`;
  }
}

function report(entry, doing, what) {
  host.logError(`plugin ${entry.id}: ${doing}`, textOf(what));
}

// The listeners plugins added for an event, as { entry, fn }, in the order
// the plugins started
function listenersOf(event) {
  const out = [];
  for (const entry of mains.values()) {
    for (const fn of entry.listeners.get(event) || []) out.push({ entry, fn });
  }
  return out;
}

// A listener that fails every time it is called would add a line to
// neo-errors.log, a file in the synced library written on the main thread,
// on every save. Its first failure is logged, then one a minute at most,
// with a count of those left out, as plugins.js does in the window.
const QUIET_MS = 60000;
let failures = new WeakMap(); // listener -> { at, untold }
function logFailure(entry, fn, event, err) {
  const now = performance.now();
  const last = failures.get(fn);
  if (last && now - last.at < QUIET_MS) {
    last.untold++;
    return;
  }
  failures.set(fn, { at: now, untold: 0 });
  const more = last && last.untold ? `${last.untold} more failures of this listener since its last line; the latest: ` : '';
  host.logError(`plugin ${entry.id}: ${event}`, more + textOf(err));
}

// Calls each listener with the detail, as plugins.js does in the window:
// one that throws, or whose promise rejects, is logged and the rest still
// run. The detail is frozen, as every listener is handed the same object.
function dispatch(event, detail) {
  Object.freeze(detail);
  for (const { entry, fn } of listenersOf(event)) {
    if (entry.failed) continue;
    try {
      const r = fn(detail);
      if (r && typeof r.then === 'function') r.then(null, (err) => logFailure(entry, fn, event, err));
    } catch (err) {
      logFailure(entry, fn, event, err);
    }
  }
}

function on(entry, event, fn) {
  if (typeof fn !== 'function') throw new TypeError(`a listener for ${event} must be a function`);
  if (entry.failed) return () => {};
  if (!entry.listeners.has(event)) entry.listeners.set(event, new Set());
  entry.listeners.get(event).add(fn);
  return () => {
    const set = entry.listeners.get(event);
    if (set) set.delete(fn);
  };
}

// what activate(host) receives
function apiFor(entry, folder) {
  const { id } = entry;
  const own = (all) => (isObject(all) && isObject(all[id]) ? all[id] : {});
  return Object.freeze({
    id,
    // answers neo.invoke(channel, payload) from this plugin's window half
    handle(channel, fn) {
      if (typeof channel !== 'string' || !CHANNEL.test(channel)) {
        throw new TypeError(`handle: ${textOf(channel)} is not a channel name (${CHANNEL})`);
      }
      if (typeof fn !== 'function') throw new TypeError(`handle('${channel}') needs a function`);
      if (entry.handlers.has(channel)) throw new TypeError(`handle: '${channel}' has a handler already`);
      if (!entry.failed) entry.handlers.set(channel, fn);
    },
    // the plugin's own object under plugins[id] in settings.json, beside
    // NEO's settings and other plugins'. set writes the whole file back, so
    // a file it cannot read, or one holding no object, is left as it is and
    // the plugin gets the error
    settings: Object.freeze({
      get: () => own(host.readSettings().plugins),
      set(obj) {
        if (!isObject(obj)) throw new TypeError('settings.set needs an object');
        const settings = host.readSettings();
        if (!isObject(settings)) throw new Error('settings.json holds no object, so settings.set leaves it as it is');
        settings.plugins = { ...(isObject(settings.plugins) ? settings.plugins : {}), [id]: obj };
        host.writeSettings(settings);
      }
    }),
    // library() follows File > Library Folder; userData is NEO's own folder
    paths: Object.freeze({ library: () => host.libraryDir(), userData: host.app.getPath('userData'), plugin: folder }),
    // neo-errors.log sits in the synced library, so only what went wrong
    // goes there; info and debug go to the console
    log(level, message, data) {
      if (!LOG_LEVELS.includes(level)) throw new TypeError(`log: no level is called ${textOf(level)}; there are ${LOG_LEVELS.join(', ')}`);
      const line = textOf(message) + (data === undefined ? '' : ' ' + textOf(data));
      if (level === 'error' || level === 'warn') host.logError(`plugin ${id}: ${level}`, line);
      else console.log(`[plugin ${id}: ${level}] ${line}`);
    },
    onAfterWrite: (fn) => on(entry, 'after-write', fn)
  });
}

// A main half that fails to start loses whatever it registered, and the
// error goes to the log; NEO and the other plugins carry on
function fail(entry, err) {
  entry.failed = true;
  entry.handlers.clear();
  entry.listeners.clear();
  report(entry, 'activate', err);
}

function start(entry, mainPath) {
  let result;
  try {
    const exported = require(mainPath);
    if (!exported || typeof exported.activate !== 'function') throw new TypeError(`${mainPath} has no activate function`);
    result = exported.activate(apiFor(entry, path.dirname(mainPath)));
  } catch (err) {
    fail(entry, err);
    return Promise.resolve();
  }
  return Promise.resolve(result).then(() => {}, (err) => fail(entry, err));
}

// Starts the main half of each plugin that has one, once. main.js calls it
// after creating the window, so no plugin holds the window back, and none
// is awaited: an activate that returns a promise runs on while NEO starts,
// and an invoke waits for it.
function activateMains() {
  for (const m of discover()) {
    if (!m.mainPath || mains.has(m.id)) continue;
    const entry = { id: m.id, ready: null, failed: false, handlers: new Map(), listeners: new Map() };
    mains.set(m.id, entry);
    entry.ready = start(entry, m.mainPath);
  }
}

// plugin:invoke: waits until the plugin's main half has started, then
// hands the payload to the handler it took for the channel. A handler's
// error is logged and goes back to the window as the rejection.
async function invoke(id, channel, payload) {
  if (typeof channel !== 'string' || !CHANNEL.test(channel)) throw new TypeError(`${textOf(channel)} is not a channel name`);
  const entry = mains.get(id);
  if (!entry) throw new Error(`no plugin called ${textOf(id)} has a main half to answer ${channel}`);
  await entry.ready;
  if (entry.failed) throw new Error(`plugin ${entry.id} failed to start its main half, so nothing answers ${channel}`);
  const fn = entry.handlers.get(channel);
  if (!fn) throw new Error(`plugin ${entry.id} has no handler for ${channel}`);
  try {
    return await fn(payload);
  } catch (err) {
    report(entry, `invoke ${channel}`, err);
    throw err;
  }
}

// main.js calls this once a write from the window has landed: book.json
// (kind 'meta', name 'book'), a chapter, an aux page or a JSON sidecar.
// Listeners hear of it on a later turn, after the window has its answer,
// so none can hold up a save or fail one.
function afterWrite(kind, bookId, name) {
  if (!listenersOf('after-write').length) return;
  setImmediate(() => dispatch('after-write', { kind, bookId, name }));
}

module.exports = { wire, validManifest, discover, menuItems, activateMains, afterWrite };
