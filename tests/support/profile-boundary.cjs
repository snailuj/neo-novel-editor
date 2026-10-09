const path = require('node:path');
const { fileURLToPath } = require('node:url');

function guardTestWrites(fs, profile, logger = () => {}) {
  const root = path.resolve(profile);
  const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  const refuse = method => {
    logger({ event: 'test.write-refused', method });
    throw Object.assign(new Error('Test write leaves its ordinary disposable profile'), { code: 'TEST_WRITE_OUTSIDE_PROFILE' });
  };
  if (fs.lstatSync(root).isSymbolicLink() || !same(fs.realpathSync(root), root)) refuse('profile');
  const check = (target, method) => {
    if (target instanceof URL) target = fileURLToPath(target);
    if (Buffer.isBuffer(target)) target = target.toString();
    if (typeof target !== 'string') refuse(method);
    const absolute = path.resolve(target), suffix = path.relative(root, absolute);
    if (path.isAbsolute(suffix) || suffix === '..' || suffix.startsWith('..' + path.sep)) refuse(method);
    let current = root;
    for (const part of suffix.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (stat.isSymbolicLink()) refuse(method);
    }
  };
  const wrap = (owner, name, indices, asynchronous = false) => {
    const original = owner[name]; if (typeof original !== 'function') return;
    const invoke = (...args) => { for (const index of indices) check(args[index], name); return original.apply(owner, args); };
    owner[name] = asynchronous ? async (...args) => invoke(...args) : invoke;
  };
  for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm', 'rmdir', 'truncate', 'chmod', 'chown', 'utimes']) {
    wrap(fs, name + 'Sync', [0]); wrap(fs, name, [0]); wrap(fs.promises, name, [0], true);
  }
  for (const name of ['rename', 'copyFile', 'cp', 'link']) {
    wrap(fs, name + 'Sync', [0, 1]); wrap(fs, name, [0, 1]); wrap(fs.promises, name, [0, 1], true);
  }
  wrap(fs, 'createWriteStream', [0]);
  const writable = flags => typeof flags === 'string' ? /[wa+]/.test(flags) : !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND));
  for (const [owner, name, asynchronous] of [[fs, 'openSync', false], [fs, 'open', false], [fs.promises, 'open', true]]) {
    const original = owner[name];
    const invoke = (...args) => { if (writable(args[1])) check(args[0], name); return original.apply(owner, args); };
    owner[name] = asynchronous ? async (...args) => invoke(...args) : invoke;
  }
  for (const name of ['symlinkSync', 'symlink']) fs[name] = () => refuse(name);
  fs.promises.symlink = async () => refuse('symlink');
}

module.exports = { guardTestWrites };
