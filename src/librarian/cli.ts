// The librarian's command line: deterministic checks over a vault on disk. Ported from
// hoard's cli.py, for the commands this port carries: lint, dangling, quotes, relink
// (report only), verify, repair (report only), duplicates and check.
//
//   npm run librarian -- <command> [--vault DIR] [--scheme FILE] [--layout hoard] ...
//
// Findings go to stdout one per line, as hoard prints them; log records go to stderr as
// JSON lines. Exit: 0 clean, 1 findings, 2 usage, 3 error (and check's 2 for a changed
// source). HOARD_TIMING=1 times each command on stderr.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import * as dangling from './dangling.ts';
import * as lint from './lint.ts';
import { type LogRecord, getLogger, setLogSink } from './log.ts';
import * as mf from './manifest.ts';
import * as quotes from './quotes.ts';
import * as relink from './relink.ts';
import { DEFAULT_SCHEME, HOARD_LAYOUT, type Layout, type Scheme, schemeFrom } from './scheme.ts';
import { readText, readVault } from './vault-fs.ts';

const log = getLogger('librarian.cli');

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  /** Where relative paths on the command line resolve from. */
  cwd: string;
}

const processIo: Io = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  env: process.env,
  cwd: process.cwd(),
};

const USAGE = 'usage: librarian {lint,dangling,quotes,relink,verify,repair,duplicates,check} [--vault DIR] [--scheme FILE]';

class UsageError extends Error {}

interface Spec {
  values?: string[];
  repeated?: string[];
  flags?: string[];
  required?: string[];
  /** Hoard's options this port leaves out, with why. */
  refused?: Record<string, string>;
}

const COMMON = ['--vault', '--scheme', '--layout'];
const SPECS: Record<string, Spec> = {
  lint: {},
  dangling: { values: ['--match'] },
  quotes: {},
  verify: {},
  duplicates: {},
  repair: { refused: { '--apply': 'repair reports only here; run hoard\'s librarian to rewrite the manifest' } },
  check: { values: ['--src', '--src-file'], required: ['--src'] },
  relink: {
    values: ['--scope', '--map-file'],
    repeated: ['--map', '--map-pipe'],
    flags: ['--check', '--map-only'],
    refused: { '--apply': 'relink reports only here and never writes a note' },
  },
};

interface Args {
  cmd: string;
  values: Map<string, string>;
  repeated: Map<string, string[]>;
  flags: Set<string>;
}

function parse(argv: readonly string[]): Args {
  const [cmd, ...rest] = argv;
  if (!cmd) throw new UsageError('the following arguments are required: command');
  const spec = SPECS[cmd];
  if (!spec) throw new UsageError(`invalid choice: '${cmd}'`);
  const values = new Set([...COMMON, ...(spec.values ?? [])]);
  const repeated = new Set(spec.repeated ?? []);
  const flags = new Set(spec.flags ?? []);
  const args: Args = { cmd, values: new Map(), repeated: new Map(), flags: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const why = spec.refused?.[name];
    if (why !== undefined) throw new UsageError(`${name}: ${why}`);
    if (flags.has(name) && inline === undefined) {
      args.flags.add(name);
      continue;
    }
    if (!values.has(name) && !repeated.has(name)) throw new UsageError(`unrecognized arguments: ${arg}`);
    const value = inline ?? rest[++i];
    if (value === undefined) throw new UsageError(`argument ${name}: expected one argument`);
    if (repeated.has(name)) args.repeated.set(name, [...(args.repeated.get(name) ?? []), value]);
    else args.values.set(name, value);
  }
  for (const name of spec.required ?? []) {
    if (!args.values.has(name)) throw new UsageError(`the following arguments are required: ${name}`);
  }
  const layout = args.values.get('--layout');
  if (layout !== undefined && layout !== 'hoard') throw new UsageError(`argument --layout: invalid choice: '${layout}' (choose from 'hoard')`);
  const scope = args.values.get('--scope');
  if (scope !== undefined && !Object.hasOwn(relink.SCOPES, scope)) {
    throw new UsageError(`argument --scope: invalid choice: '${scope}' (choose from 'all', 'librarian', 'author')`);
  }
  return args;
}

/** A scheme file: JSON naming any of DEFAULT_SCHEME's keys, each the same shape. */
function loadScheme(file: string): Scheme {
  return schemeFrom(JSON.parse(readText(file)), file);
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

function loadManifest(root: string, layout: Layout): mf.ManifestRecordV1[] {
  const file = path.join(root, layout.manifestPath);
  return existsSync(file) ? mf.parseManifest(readText(file)) : [];
}

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Whether any version of dest in git history hashes to want: the body for Markdown, the
 * bytes otherwise. Each revision is paired with the path the file had then, so a rename
 * is followed. A folder that is no repository has no history.
 */
function hashInHistory(root: string, dest: string, want: string, md: boolean): boolean {
  const out = spawnSync('git', ['-C', root, 'log', '--follow', '--format=%H', '--name-only', '--', dest], { encoding: 'utf8' });
  const pairs: [string, string][] = [];
  let rev: string | null = null;
  for (const raw of (out.stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (HEX40.test(line)) rev = line;
    else if (rev) pairs.push([rev, line]);
  }
  for (const [at, file] of pairs) {
    // Bytes, not text: a binary dest read as text would be a false accusation.
    const blob = spawnSync('git', ['-C', root, 'show', `${at}:${file}`]);
    if (blob.status !== 0) continue;
    // Python decodes the blob without universal newlines, so neither does this.
    const got = md ? sha256(mf.hashedBody(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob.stdout)))
      : sha256(blob.stdout);
    if (got === want) return true;
  }
  return false;
}

function probe(root: string): mf.VerifyProbe {
  const at = (rel: string) => path.resolve(root, rel);
  return {
    exists: (rel) => existsSync(at(rel)),
    bodySha: (rel) => sha256(mf.hashedBody(readText(at(rel)))),
    fileSha: (rel) => sha256(readFileSync(at(rel))),
    hashInHistory: (dest, want, md) => hashInHistory(root, dest, want, md),
  };
}

function run(args: Args, io: Io): number {
  const print = (line: string) => io.stdout(`${line}\n`);
  const timed = <T>(label: string, work: () => T): T => {
    if (io.env['HOARD_TIMING'] !== '1') return work();
    const start = performance.now();
    try {
      return work();
    } finally {
      io.stderr(`${label}: ${Math.round(performance.now() - start)}ms\n`);
    }
  };
  const root = path.resolve(io.cwd, args.values.get('--vault') ?? '.');
  const layout = HOARD_LAYOUT;
  const schemeFile = args.values.get('--scheme');
  const scheme = schemeFile === undefined ? DEFAULT_SCHEME : loadScheme(path.resolve(io.cwd, schemeFile));

  switch (args.cmd) {
    case 'lint': {
      const findings = timed('lint', () => {
        const { notes, attachments } = readVault(root, layout);
        const logFile = path.join(root, layout.logPath);
        const logText = existsSync(logFile) ? readText(logFile) : '';
        return lint.checkVault(notes, { attachments, scheme, layout, logText });
      });
      findings.forEach(print);
      // Informational findings print but never fail the check.
      return lint.fails(findings) ? 1 : 0;
    }
    case 'dangling': {
      let items = timed('dangling', () => {
        const { notes, attachments } = readVault(root, layout);
        return dangling.collect(notes, attachments, layout);
      });
      const match = args.values.get('--match');
      if (match) items = dangling.matching(items, match);
      dangling.report(items).forEach(print);
      // Unresolved links are outlining, not debt: only a near miss fails.
      return items.some((d) => d.near) ? 1 : 0;
    }
    case 'quotes': {
      const findings = timed('quotes', () => quotes.checkVault(readVault(root, layout).notes, { layout }));
      findings.forEach(print);
      return quotes.fails(findings) ? 1 : 0;
    }
    case 'verify': {
      const errors = timed('verify', () => mf.verify(loadManifest(root, layout), probe(root)));
      errors.forEach(print);
      return errors.length ? 1 : 0;
    }
    case 'repair': {
      const vaultRoot = existsSync(root) ? realpathSync(root) : root;
      const records = loadManifest(root, layout);
      const { changes } = mf.repairRecords(records, vaultRoot);
      for (const [old, fixed] of changes) print(`dest absolute -> vault-relative: ${old} -> ${fixed}`);
      const stranded = mf.unrepairableDests(records, vaultRoot);
      for (const dest of stranded) print(`dest absolute, NOT under ${vaultRoot} -- run repair on that checkout: ${dest}`);
      if (!changes.length) {
        if (stranded.length) {
          log.info(`repair: ${stranded.length} record(s) need another checkout`);
          return 1;
        }
        log.info(`repair: nothing to fix across ${records.length} record(s)`);
        return 0;
      }
      log.info(`repair: ${changes.length} record(s) need fixing; this port reports only`);
      return 1;
    }
    case 'duplicates': {
      for (const group of mf.duplicates(loadManifest(root, layout))) {
        print(group.map((r) => `${r.src} -> ${r.dest}`).join(' | '));
      }
      return 0;
    }
    case 'check': {
      const src = args.values.get('--src')!;
      const given = args.values.get('--src-file');
      const srcFile = given !== undefined ? path.resolve(io.cwd, given)
        : existsSync(path.resolve(io.cwd, src)) ? path.resolve(io.cwd, src) : null;
      if (srcFile === null) {
        log.error('check: no hashable source (pass --src-file)');
        return 3;
      }
      const srcSha = sha256(readFileSync(srcFile));
      const sameSrc = loadManifest(root, layout).filter((r) => r.src === src);
      const hits = sameSrc.filter((r) => r.src_sha256 === srcSha);
      if (hits.length) {
        print(`ingested (${hits.length} record(s))`);
        return 0;
      }
      if (sameSrc.length) {
        print(`changed (${sameSrc.length} prior record(s))`);
        return 2;
      }
      print('not ingested');
      return 1;
    }
    case 'relink': {
      const mapFile = args.values.get('--map-file');
      const mapping = relink.parseMap(args.repeated.get('--map') ?? null, args.repeated.get('--map-pipe') ?? null,
        mapFile === undefined ? null : readText(path.resolve(io.cwd, mapFile)));
      const scope = (args.values.get('--scope') ?? 'all') as relink.Scope;
      const report = timed('relink', () => {
        const { notes, attachments } = readVault(root, layout);
        return relink.plan(notes, mapping, scope, args.flags.has('--map-only'), { attachments, layout });
      });
      const verb = args.flags.has('--check') ? 'librarian relink --check' : 'librarian relink';
      relink.reportLines(report.rewrites, report.notes, 'pending').forEach(print);
      if (!report.rewrites.length) print(`${verb}: nothing to rewrite`);
      return report.rewrites.length ? 1 : 0;
    }
    default:
      throw new Error(`unhandled command ${args.cmd}`);
  }
}

/** Runs one command; returns its exit code. */
export function main(argv: readonly string[], io: Io = processIo): number {
  const previous = setLogSink((record: LogRecord) => {
    if (record.level !== 'debug') io.stderr(`${JSON.stringify(record)}\n`);
  });
  try {
    let args: Args;
    try {
      args = parse(argv);
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      io.stderr(`${USAGE}\nlibrarian: error: ${err.message}\n`);
      return 2;
    }
    try {
      return run(args, io);
    } catch (err) {
      // The boundary: log and escalate through the exit code.
      log.error(`librarian ${args.cmd} failed: ${(err as Error).message}`);
      return 3;
    }
  } finally {
    setLogSink(previous);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
