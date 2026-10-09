// electron-builder's beforeBuild hook: packaging builds the TypeScript layer first, so
// a bare `npx electron-builder` in CI ships plugins/hoard. It returns true: electron-builder
// reads any falsy result as "node_modules is handled externally" and skips rebuilding
// native dependencies such as koffi.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = function beforeBuild() {
  execFileSync(process.execPath, [path.join(__dirname, 'build.mjs')], { stdio: 'inherit' });
  return true;
};
