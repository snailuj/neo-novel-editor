// Generates the committed types and the standalone validators from schemas/.
//   node tools/gen.mjs [--check] [--root <dir>]
// --root names a directory holding schemas/ and src/generated/ (default: the repository).
// --check writes nothing: it prints each generated file that differs and exits 1.
// This module is only ever run as a command, so it has no "am I the entry point" test
// that a symlink, junction or drive-letter case could defeat; the library is generate.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const options = { check: false, root: repoRoot };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') options.check = true;
    else if (argv[i] === '--root') {
      if (!argv[i + 1]) throw new Error('--root needs a directory');
      options.root = path.resolve(argv[++i]);
    } else throw new Error(`unknown argument ${argv[i]}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const { differing } = await generate(options);
if (options.check && differing.length > 0) {
  for (const file of differing) console.error(`out of date: ${file}`);
  console.error('Run `npm run gen` and commit the result.');
  process.exitCode = 1;
}
