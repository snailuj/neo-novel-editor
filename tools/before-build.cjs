// electron-builder's beforeBuild hook: packaging builds the TypeScript layer first, so
// a bare `npx electron-builder` in CI ships plugins/hoard. It returns undefined, because
// `false` would tell electron-builder to skip rebuilding native dependencies.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = function beforeBuild() {
  execFileSync(process.execPath, [path.join(__dirname, 'build.mjs')], { stdio: 'inherit' });
};
