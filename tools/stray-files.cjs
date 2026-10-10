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
const isGenerated = (file) => file.startsWith('node_modules/') || file.startsWith('plugins/');

function why(file, known) {
  if (isGenerated(file)) return null;
  if (!known.has(file)) return 'not tracked by git';
  return null;
}

module.exports = { findStrays };
