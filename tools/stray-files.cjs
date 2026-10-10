// What may sit inside a packaged app, as a pure function so the rules can be tested
// without a build. tools/after-pack.cjs feeds it the real package and the git tracked list.
//   findStrays(packaged, tracked) -> [{ path, reason }]
// Paths are normalised to git's form (forward slashes, no leading ./ or /): asar and
// Windows give backslashes, git never does.

const normalize = (p) => p.replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '');

function findStrays(packaged, tracked) {
  const known = new Set(tracked.map(normalize));
  const strays = [];
  for (const raw of packaged) {
    const file = normalize(raw);
    const reason = why(file, known);
    if (reason) strays.push({ path: raw, reason });
  }
  return strays;
}

// The owner's private writing lives in NEO libraries and an Obsidian vault. These are the
// names NEO and Obsidian give the files and folders there, matched anywhere in the package,
// node_modules included. Each is as narrow as the real name allows so a dependency that
// merely shares a word (an `exports` folder, a `book-cover` package) does not trip one.
// Backups, Exports and Deleted Books are matched with NEO's capitals for that reason.
const FOLDER_MARKERS = [
  [/^\.superpowers$/i, 'agent working notes'],
  [/^\.obsidian$/i, 'Obsidian vault folder'],
  [/^_meta$/i, 'vault notes folder'],
  [/^\.neo$/i, 'NEO provenance folder'],
  [/^(?:Backups|Exports|Deleted Books)$/, 'NEO library folder'],
  // book-<slug>-<base36 time>-<random>, as main.js names a new book
  [/^book-(?:[a-z0-9-]*-)?[a-z0-9]{8}-[a-z0-9]{1,5}$/i, 'NEO book folder'],
];
const FILE_MARKERS = [
  [/^(?:library|book|darlings|stickies|art|snapshot)\.json(?:\.tmp|\.bak)?$/i, 'NEO library file'],
  [/^_catalog\.txt$/i, 'NEO library catalogue'],
  [/^neo-errors\.log$/i, 'NEO error log'],
  [/^(?:notes|outline)\.html$/i, 'NEO book page'],
  [/^ch-[a-z0-9-]+\.html$/i, 'NEO chapter'],
  [/^neo-backup-.*\.zip(?:\.tmp)?$/i, 'NEO library backup'],
  // Date.now() in milliseconds is 13 digits; ten keeps `cover-1.png` out
  [/^(?:cover|art)-\d{10,}\.[a-z]+$/i, 'NEO book image'],
];

function markerReason(file) {
  const folders = file.split('/');
  const name = folders.pop();
  for (const folder of folders) {
    const marker = FOLDER_MARKERS.find(([pattern]) => pattern.test(folder));
    if (marker) return `writing marker: ${marker[1]} "${folder}/"`;
  }
  const marker = FILE_MARKERS.find(([pattern]) => pattern.test(name));
  if (marker) return `writing marker: ${marker[1]} "${name}"`;
  // main.js reads every .html in a book's chapters folder as a chapter
  if (/\.html$/i.test(name) && folders.at(-1)?.toLowerCase() === 'chapters') {
    return `writing marker: NEO chapter "${name}"`;
  }
  return null;
}

// node_modules and plugins/ are installed or built, so git does not list them.
const inNodeModules = (file) => file.startsWith('node_modules/');
const inPlugins = (file) => file.startsWith('plugins/');

// Tracked, but there to build or test NEO, never to run it.
const DEV_ONLY = [
  [/^docs\//, 'docs/ (plans and specs)'],
  [/(?:^|\/)tsconfig[^/]*\.json$/, 'tsconfig (TypeScript settings)'],
  [/(?:^|\/)playwright\.config\.[^/]+$/, 'playwright config'],
  [/(?:^|\/)\.oxlintrc\.json$/, '.oxlintrc.json (oxlint settings)'],
  [/\.md$/i, '.md file'],
];

// A plugin is a manifest and the code it names, inside its own plugins/<id>/ folder.
// Data, maps and notes have no business in it, and nothing sits loose in plugins/.
function pluginReason(file) {
  if (/^plugins\/[^/]+\/plugin\.json$/.test(file) || /^plugins\/[^/]+\/.*\.(?:js|cjs|mjs|css)$/.test(file)) return null;
  return 'plugin file that is neither plugin.json nor .js, .cjs, .mjs or .css';
}

function why(file, known) {
  const marked = markerReason(file);
  if (marked) return marked;
  if (inNodeModules(file)) return null;
  if (inPlugins(file)) return pluginReason(file);
  const dev = DEV_ONLY.find(([pattern]) => pattern.test(file));
  if (dev) return `development file: ${dev[1]}`;
  if (!known.has(file)) return 'not tracked by git';
  return null;
}

module.exports = { findStrays };
