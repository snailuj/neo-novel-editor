// The block classifier's command line.
//
//   npm run blocks -- classify --vault DIR --out SHEET.csv [--already LIST] [--judge CMD]
//                     [--votes N] [--jobs N] [--pages FILE] [PAGE...]
//   npm run blocks -- apply --vault DIR --sheet SHEET.csv --out DIR [--path-prefix P] [--picks FILE]
//
// classify splits each page into blocks and writes the review sheet, after every page so
// a stopped run loses nothing; a re-run judges only blocks the sheet lacks. apply writes
// the wiki pages, the Morning Pages book and the import list from the reviewed sheet, and
// with --picks a JSONL file of line-range picks for the old vault's import to cut itself.
// Summaries go to stdout, log records to stderr as JSON lines. Exit: 0 done, 1 apply
// found blocks that changed since review, 2 usage, 3 error.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { getLogger, setLogSink } from '../log.ts';
import { applySheet, blockPicks } from './apply.ts';
import { commandJudge, judgePage, type JudgeFn } from './judge.ts';
import { ruleLabel } from './rules.ts';
import { type Already, dedupeRows, mergeRows, parseAlready, readSheet, type Row, rowsFor, writeSheet } from './sheet.ts';
import { splitBlocks } from './split.ts';

const log = getLogger('librarian.blocks.cli');

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
}

class UsageError extends Error {}

const USAGE = 'usage: blocks classify --vault DIR --out SHEET [--already LIST] [--judge CMD] [--votes N] [--jobs N] [--pages FILE] [PAGE...]\n'
  + '       blocks apply --vault DIR --sheet SHEET --out DIR [--path-prefix P] [--picks FILE [--picks-kinds writing,morning-pages]]';

const VALUES: Record<string, string[]> = {
  classify: ['--vault', '--out', '--already', '--judge', '--votes', '--jobs', '--pages'],
  apply: ['--vault', '--sheet', '--out', '--path-prefix', '--picks', '--picks-kinds'],
};
const REQUIRED: Record<string, string[]> = { classify: ['--vault', '--out'], apply: ['--vault', '--sheet', '--out'] };

function parse(argv: readonly string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || !VALUES[cmd]) throw new UsageError(cmd ? `unknown command '${cmd}'` : 'a command is required');
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (!VALUES[cmd].includes(arg)) throw new UsageError(`unknown option ${arg}`);
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    values.set(arg, value);
  }
  for (const name of REQUIRED[cmd]!) if (!values.has(name)) throw new UsageError(`${name} is required`);
  if (cmd === 'apply' && positional.length) throw new UsageError(`unexpected ${positional[0]}`);
  return { cmd, values, positional };
}

const count = (value: string | undefined, name: string, fallback: number) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a whole number from 1`);
  return n;
};

/** Writes beside the target, then renames over it, so a stop mid-write leaves the last sheet. */
function writeAtomic(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

async function classify(values: Map<string, string>, positional: string[], io: Io): Promise<number> {
  const at = (p: string) => path.resolve(io.cwd, p);
  const vault = at(values.get('--vault')!);
  const sheetFile = at(values.get('--out')!);
  const votes = count(values.get('--votes'), '--votes', 1);
  const jobs = count(values.get('--jobs'), '--jobs', 1);
  const judgeCmd = values.get('--judge');
  const judge: JudgeFn | null = judgeCmd ? commandJudge(judgeCmd) : null;
  const already: Already[] = values.has('--already') ? parseAlready(readFileSync(at(values.get('--already')!), 'utf8')) : [];
  const listed = values.has('--pages')
    ? readFileSync(at(values.get('--pages')!), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  const pages = [...new Set([...listed, ...positional].map((p) => p.replace(/\\/g, '/')))];
  if (!pages.length) throw new UsageError('name at least one page');

  const old = existsSync(sheetFile) ? readSheet(readFileSync(sheetFile, 'utf8')) : [];
  const byPage = new Map<string, Row[]>();
  for (const r of old) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);
  // Pages from earlier runs keep their place; this run's new pages follow in order.
  const order = [...new Set([...byPage.keys(), ...pages])];
  const save = () => writeAtomic(sheetFile, writeSheet(order.flatMap((p) => byPage.get(p) ?? [])));

  let failed = 0;
  const fresh = new Set<string>();
  const one = async (page: string) => {
    const started = performance.now();
    const file = path.join(vault, page);
    if (!existsSync(file)) {
      log.error(`${page}: no such page in the vault`);
      failed++;
      return;
    }
    const blocks = splitBlocks(readFileSync(file, 'utf8'));
    const prior = byPage.get(page) ?? [];
    const known = new Set(prior.map((r) => r.block));
    const todo = blocks.filter((b) => !known.has(b.id));
    for (const b of todo) fresh.add(`${page}\0${b.id}`);
    const judged = judge && todo.length ? await judgePage(page, todo, judge, { votes }) : new Map();
    const merged = mergeRows(prior, rowsFor(page, blocks, judged, already));
    const dropped = prior.filter((r) => !blocks.some((b) => b.id === r.block));
    for (const r of dropped) log.warning(`${page}: block ${r.block} (was lines ${r.lines}) is gone from the page; its row is dropped`);
    byPage.set(page, merged);
    save();
    const ruled = todo.filter((b) => ruleLabel(b)).length;
    log.info(`${page}: ${blocks.length} blocks, ${todo.length} new (${ruled} by rule, ${judged.size} judged x${votes}), ${Math.round(performance.now() - started)}ms`);
  };

  const queue = [...pages];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let page = queue.shift(); page !== undefined; page = queue.shift()) await one(page);
  }));
  const dupes = dedupeRows(order.flatMap((p) => byPage.get(p) ?? []), (r) => fresh.has(`${r.page}\0${r.block}`));
  if (dupes) log.info(`${dupes} new rows repeat text an earlier row sends to the wiki; set to no`);
  save();

  const rows = order.flatMap((p) => byPage.get(p) ?? []);
  const tally = (key: 'label' | 'wiki') => [...rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) ?? 0) + 1), new Map<string, number>())]
    .map(([k, n]) => `${k} ${n}`).join(', ');
  io.stdout(`${rows.length} blocks in ${order.length} pages. Labels: ${tally('label')}. Wiki: ${tally('wiki')}. Book: ${rows.filter((r) => r.book).length}.\n`);
  return failed ? 3 : 0;
}

function apply(values: Map<string, string>, io: Io): number {
  const at = (p: string) => path.resolve(io.cwd, p);
  // Checked before anything is written, so a usage error writes nothing.
  const kinds = (values.get('--picks-kinds') ?? 'writing,morning-pages').split(',').map((k) => k.trim());
  for (const k of kinds) if (k !== 'writing' && k !== 'morning-pages') throw new UsageError(`--picks-kinds: unknown kind '${k}'`);
  const rows = readSheet(readFileSync(at(values.get('--sheet')!), 'utf8'));
  const prefix = values.get('--path-prefix');
  const result = applySheet(at(values.get('--vault')!), rows, at(values.get('--out')!), prefix === undefined ? {} : { pathPrefix: prefix });
  const picksFile = values.get('--picks');
  if (picksFile !== undefined) {
    const picks = blockPicks(at(values.get('--vault')!), rows).picks.filter((p) => kinds.includes(p.kind));
    writeAtomic(at(picksFile), picks.map((p) => JSON.stringify(p)).join('\n') + (picks.length ? '\n' : ''));
    io.stdout(`Wrote ${picks.length} picks to ${picksFile}.\n`);
  }
  io.stdout(`Wrote ${result.written.length} files. ${result.unresolved} rows still marked check for the wiki.\n`);
  for (const m of result.missing) io.stdout(`changed since review: ${m.page} lines ${m.lines} (block ${m.block})\n`);
  return result.missing.length ? 1 : 0;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const previous = setLogSink((record) => io.stderr(`${JSON.stringify(record)}\n`));
  try {
    const { cmd, values, positional } = parse(argv);
    return cmd === 'classify' ? await classify(values, positional, io) : apply(values, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${USAGE}\nblocks: error: ${err.message}\n`);
      return 2;
    }
    io.stderr(`blocks: error: ${(err as Error).message}\n`);
    return 3;
  } finally {
    setLogSink(previous);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const io: Io = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t), cwd: process.cwd() };
  process.exitCode = await main(process.argv.slice(2), io);
}
