'use strict';

// Every function of Node's fs and fs.promises that the write guard (scripts/isolate-test-app.js)
// does not wrap, with why that is safe. A test lists the functions of the fs it runs against: one
// that is neither wrapped nor named here is new, and has to be read before it goes in a list. If
// it writes through a path it belongs in the guard.

// Reads, stats and watches: they change nothing.
const READS = [
  'access', 'accessSync', 'close', 'closeSync', 'createReadStream', 'exists', 'existsSync', 'fstat',
  'fstatSync', 'glob', 'globSync', 'lstat', 'lstatSync', 'openAsBlob', 'opendir', 'opendirSync', 'read',
  'readFile', 'readFileSync', 'readSync', 'readdir', 'readdirSync', 'readlink', 'readlinkSync', 'readv',
  'readvSync', 'realpath', 'realpathSync', 'stat', 'statSync', 'statfs', 'statfsSync', 'unwatchFile',
  'watch', 'watchFile', '_toUnixTimestamp'
];

// They act on a file descriptor, and one comes only from open, which the guard wraps.
const DESCRIPTOR = [
  'fchmod', 'fchmodSync', 'fchown', 'fchownSync', 'fdatasync', 'fdatasyncSync', 'fsync', 'fsyncSync',
  'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync', 'write', 'writeSync', 'writev', 'writevSync'
];

// Classes. The streams and Dir open their file with fs.open, which the guard wraps.
const CLASSES = [
  'Dir', 'Dirent', 'FileReadStream', 'FileWriteStream', 'ReadStream', 'Stats', 'Utf8Stream', 'WriteStream'
];

module.exports = { UNGUARDED: [...READS, ...DESCRIPTOR, ...CLASSES] };
