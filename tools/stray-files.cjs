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

// A plugin is a manifest and the code it names. Data, maps and notes have no business in it.
function pluginReason(file) {
  if (/^plugins\/[^/]+\/plugin\.json$/.test(file) || /\.(?:js|cjs|mjs|css)$/.test(file)) return null;
  return 'plugin file that is neither plugin.json nor .js, .cjs, .mjs or .css';
}

function why(file, known) {
  if (inNodeModules(file)) return null;
  if (inPlugins(file)) return pluginReason(file);
  const dev = DEV_ONLY.find(([pattern]) => pattern.test(file));
  if (dev) return `development file: ${dev[1]}`;
  if (!known.has(file)) return 'not tracked by git';
  return null;
}

module.exports = { findStrays };
