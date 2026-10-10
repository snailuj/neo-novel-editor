// Builds the TypeScript layer into the plugins directory.
//   node tools/build.mjs [--root <dir>] [--out <dir>]
// --root names a directory laid out as the repository is (schemas/, src/), which the build
// reads and regenerates in; the default is the repository. --out defaults to <root>/plugins.
// Generates types and validators from schemas/ first, then checks src/hoard/plugin.json
// against its schema, so a bad manifest fails the build instead of the plugin host.
// Writes one JSON line per target: {event: 'build.target', name, ms, bytes}.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.mjs';
import { bundles, copies } from './targets.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// An unknown flag is an error: a mistyped --root would otherwise build the repository.
function parseArgs(argv) {
  const options = { root: repoRoot, out: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--root' && flag !== '--out') throw new Error(`unknown argument ${flag}`);
    if (!argv[i + 1]) throw new Error(`${flag} needs a directory`);
    options[flag.slice(2)] = path.resolve(argv[++i]);
  }
  return options;
}

async function timed(name, outfile, work) {
  const start = performance.now();
  await work();
  const ms = Math.round(performance.now() - start);
  const { size: bytes } = await stat(outfile);
  console.log(JSON.stringify({ event: 'build.target', name, ms, bytes }));
}

// The manifest is read from disk and checked by the validator generate.mjs just wrote.
async function checkManifest(root) {
  const file = path.join(root, 'src', 'hoard', 'plugin.json');
  const { validatePluginManifestV1: validate } = createRequire(import.meta.url)(
    path.join(root, 'src', 'generated', 'validators.cjs'),
  );
  if (!validate(JSON.parse(await readFile(file, 'utf8')))) {
    const why = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new Error(`src/hoard/plugin.json is not a valid plugin manifest: ${why}`);
  }
}

const { root, out: outOption } = parseArgs(process.argv.slice(2));
const out = outOption ?? path.join(root, 'plugins');

await generate({ root });
await checkManifest(root);

for (const { name, entry, outfile, options } of bundles) {
  const target = path.join(out, outfile);
  await timed(name, target, () => build({
    entryPoints: [path.join(root, entry)],
    outfile: target,
    bundle: true,
    logLevel: 'warning',
    ...options,
  }));
}

for (const { name, from, to } of copies) {
  const target = path.join(out, to);
  await mkdir(path.dirname(target), { recursive: true });
  await timed(name, target, () => copyFile(path.join(root, from), target));
}
