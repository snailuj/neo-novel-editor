// Builds the TypeScript layer into the plugins directory.
//   node tools/build.mjs [--out <dir>]
// Writes one JSON line per target: {event: 'build.target', name, ms, bytes}.
import { build } from 'esbuild';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundles, copies } from './targets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function outputDir(argv) {
  const at = argv.indexOf('--out');
  if (at === -1) return path.join(root, 'plugins');
  const dir = argv[at + 1];
  if (!dir) throw new Error('--out needs a directory');
  return path.resolve(dir);
}

async function timed(name, outfile, work) {
  const start = performance.now();
  await work();
  const ms = Math.round(performance.now() - start);
  const { size: bytes } = await stat(outfile);
  console.log(JSON.stringify({ event: 'build.target', name, ms, bytes }));
}

const out = outputDir(process.argv.slice(2));

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
