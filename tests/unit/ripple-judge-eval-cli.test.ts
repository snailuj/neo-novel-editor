// The ripple judge eval from end to end, on a synthetic git vault and a fake `claude`:
// - a dry run builds every packet and scores placement, and starts no process at all;
// - a judged run scores the judge's answer and the screen's yes pages, and a rerun
//   skips every call whose answer is already in;
// - nothing is ever written inside the vault.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BRIEF } from '../../src/hoard/ripple/engine.ts';
import { main, type Runner } from '../../src/hoard/ripple/judge-eval-cli.ts';
import { sha256 } from '../../src/hoard/ripple/rulings.ts';
import { isolateGitConfig, tempDir } from './git-support.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'src/hoard/ripple/judge-eval-cli.ts');
type T = Parameters<typeof tempDir>[0];

function setup(t: T) {
  isolateGitConfig(t, { name: 'Test', email: 'test@example.invalid' });
  const vault = tempDir(t, 'ripple-eval-vault-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: vault, encoding: 'utf8' });
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    writeFileSync(path.join(vault, rel), text);
  };
  git('init', '-q');
  write('lore/Net-Loft.md', 'Nets dry here.\n');
  write('lore/Old-Pier.md', 'The old pier rots by the [[Net-Loft]].\n');
  write('lore/Salt-Barn.md', '---\naliases: [Barn]\n---\nSalt is stored here, far from the sea.\n');
  write('inbox/Scrap.md', 'Not a roster page.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const before = git('rev-parse', 'HEAD').trim();
  write('sources/Gale-Log.md', 'The gale tore the nets at the [[Net-Loft]] and shook the old pier.\n');
  write('lore/Net-Loft.md', 'Nets dry here. See [[Gale-Log]].\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'ingest and ripple');
  const scored = tempDir(t, 'ripple-eval-scored-');
  writeFileSync(path.join(scored, 'key.json'), JSON.stringify({
    note: 'synthetic', cases: [{ source: 'sources/Gale-Log.md', readAt: before, pastTargets: [], wholeRosterPacketChars: 0, lists: [] }],
  }));
  writeFileSync(path.join(scored, 'sheet.md'), '## Case 1: sources/Gale-Log.md\n\n- [x] [[Net-Loft]] (lore/Net-Loft.md): \n- [ ] [[Old-Pier]] (lore/Old-Pier.md): \n');
  const out = tempDir(t, 'ripple-eval-out-');
  return { vault, git, scored, out, before };
}

const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 400 };
const ECHO = 'Never invent facts. Every proposal rests on the source\'s own words, quoted.';

// verbose: as `claude -p --output-format json` prints when settings.json has "verbose": true
function fakeClaude(calls: { args: string[]; cwd: string }[], verbose = false): Runner {
  const printed = (result: Record<string, unknown>) => JSON.stringify(verbose
    ? [{ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [] } }, result]
    : result);
  return async ({ args, stdin, cwd }) => {
    calls.push({ args, cwd });
    if (args.includes('--max-turns')) {
      const yes = /^## Page: Net-Loft$/m.test(stdin);
      return { code: 0, stderr: '', stdout: printed({ type: 'result', result: `{"affects": ${yes}, "confidence": 0.9, "why": "It is named."}`, usage, total_cost_usd: 0.001, duration_ms: 3 }) };
    }
    const answer = /^- Answer file: (.+)$/m.exec(stdin)![1]!;
    writeFileSync(answer, [
      { kind: 'preflight', brief_sha256: sha256(DEFAULT_BRIEF), echo: ECHO },
      { kind: 'topic', target: 'Net-Loft', line: 'See [[Gale-Log]].', reason: 'r', quote: 'The gale tore the nets' },
      { kind: 'nothing', target: 'Old-Pier', reason: 'r' },
    ].map((l) => JSON.stringify(l)).join('\n'));
    return { code: 0, stderr: '', stdout: printed({ type: 'result', result: 'done', usage, total_cost_usd: 0.02, duration_ms: 9 }) };
  };
}

test('a dry run builds every packet and scores placement, with no model call and nothing written in the vault', (t) => {
  const { vault, git, scored, out } = setup(t);
  // a `claude` that is not there: any spawn would fail the run
  const run = spawnSync(process.execPath, [cli, '--vault', vault, '--scored', scored, '--out', out, '--dry-run',
    '--claude', path.join(out, 'no-such-claude'), '--map-chars', '400'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /model extras are missing/i, 'says loudly that the model is not loaded');
  const lib = path.join(out, 'libs', '01-gale-log');
  assert.equal(readFileSync(path.join(lib, 'lore/Net-Loft.md'), 'utf8'), 'Nets dry here.\n', 'the library is the vault before the source');
  assert.ok(!existsSync(path.join(lib, 'inbox/Scrap.md')));
  assert.equal(readFileSync(path.join(lib, '.neo/ripple/brief.md'), 'utf8'), DEFAULT_BRIEF);
  const packet = readFileSync(path.join(out, 'packets', 'base-1', '01-gale-log.md'), 'utf8');
  assert.ok(packet.includes(`- Answer file: ${path.join(out, 'runs', 'base-1', '01-gale-log.jsonl')}`));
  assert.ok(packet.includes(`- Library: ${lib}`));
  assert.match(readFileSync(path.join(out, 'packets', 'map-1', '01-gale-log.md'), 'utf8'), /## Wiki map/);
  assert.match(readFileSync(path.join(out, 'packets', 'budget-1', '01-gale-log.md'), 'utf8'), /in full and \d+ by name only/);
  const md = readFileSync(path.join(out, 'eval.md'), 'utf8');
  for (const arm of ['base', 'budget', 'wide', 'map']) assert.match(md, new RegExp(`^\\| ${arm} \\| 1 \\| `, 'm'), arm);
  assert.match(md, /^\| base \| 1 \| 1 \| 0 \| 0 \| 0 \| \d+ \|$/m, 'the ticked page is a full card in base');
  assert.ok(!existsSync(path.join(out, 'runs')), 'no run was made');
  assert.ok(JSON.parse(readFileSync(path.join(out, 'eval.json'), 'utf8')).report.placement.length >= 4);
  assert.equal(git('status', '--porcelain'), '', 'the vault is untouched');
});

test('a judged run scores the judge and the screen, and a rerun skips what is done', async (t) => {
  const { vault, git, scored, out } = setup(t);
  const calls: { args: string[]; cwd: string }[] = [];
  const logs: string[] = [];
  const argv = ['--vault', vault, '--scored', scored, '--out', out, '--arms', 'base,screen,screened', '--claude', 'fake-claude', '--jobs', '2'];
  await main(argv, { runner: fakeClaude(calls), log: (m) => logs.push(m) });
  const lib = path.join(out, 'libs', '01-gale-log');
  const judge = calls.filter((c) => !c.args.includes('--max-turns'));
  const screen = calls.filter((c) => c.args.includes('--max-turns'));
  assert.equal(judge.length, 2, 'base and screened each judged once');
  assert.equal(screen.length, 3, 'one screen call per candidate');
  // The user's hooks, MCP servers and skills would add turns and tokens to every call.
  for (const c of calls) {
    assert.equal(c.args[c.args.indexOf('--setting-sources') + 1], 'project,local', 'user settings are left out');
    assert.ok(c.args.includes('--strict-mcp-config') && !c.args.includes('--mcp-config'), 'no MCP server is loaded');
    assert.ok(c.args.includes('--disable-slash-commands'), 'no skill is loaded');
  }
  for (const c of judge) {
    assert.equal(c.cwd, lib);
    assert.deepEqual(c.args.slice(0, 7), ['-p', '--output-format', 'json', '--model', 'opus', '--permission-mode', 'acceptEdits']);
    assert.ok(c.args.includes(lib));
  }
  const screened = readFileSync(path.join(out, 'packets', 'screened-1', '01-gale-log.md'), 'utf8');
  assert.match(screened, /^1 in full and 2 by name only\./m, 'only the screen\'s yes page is full');
  const md = readFileSync(path.join(out, 'eval.md'), 'utf8');
  assert.match(md, /^\| base-1 \| 1 \| 1 of 1 \| 0 \| 0 \| 1 \|/m);
  assert.match(md, /^\| screen-1 \| 1 \| 1 of 1 \| 0 \| 0 \| 0 \|/m);
  assert.match(md, /## Against base-1/);
  assert.ok(existsSync(path.join(out, 'runs', 'base-1', '01-gale-log.jsonl.usage.json')));
  assert.equal(JSON.parse(readFileSync(path.join(out, 'eval.json'), 'utf8')).report.totals[0].costUsd, 0.02);
  assert.ok(logs.some((l) => /tokens/.test(l)), 'token totals are logged');

  await main(argv, { runner: fakeClaude(calls), log: () => {} });
  assert.equal(calls.length, 5, 'a rerun makes no call');
  assert.match(readFileSync(path.join(out, 'eval.md'), 'utf8'), /^\| base-1 \| 1 \| 1 of 1 \|/m, 'and scores the same');
  assert.equal(git('status', '--porcelain'), '');
});

test('an answer that does not validate is recorded and the run goes on', async (t) => {
  const { vault, scored, out } = setup(t);
  const runner: Runner = async ({ stdin }) => {
    writeFileSync(/^- Answer file: (.+)$/m.exec(stdin)![1]!, '{"kind": "nothing", "target": "Net-Loft", "reason": "r"}\n');
    return { code: 0, stderr: '', stdout: JSON.stringify({ result: 'done', usage, total_cost_usd: 0.01, duration_ms: 1 }) };
  };
  await main(['--vault', vault, '--scored', scored, '--out', out, '--arms', 'base,map', '--claude', 'x'], { runner, log: () => {} });
  const md = readFileSync(path.join(out, 'eval.md'), 'utf8');
  assert.match(md, /## Runs that failed/);
  assert.match(md, /\| map-1 \| 01-gale-log \| line 1 must be the preflight/);
});

test('the eval refuses to write inside the vault', async (t) => {
  const { vault, scored } = setup(t);
  const never: Runner = async () => { throw new Error('no call expected'); };
  await assert.rejects(main(['--vault', vault, '--scored', scored, '--out', path.join(vault, 'eval'), '--dry-run'], { runner: never, log: () => {} }), /inside the vault/);
  assert.ok(!existsSync(path.join(vault, 'eval')));
});

test('claude printing its verbose message list scores and costs the same as its one result object', async (t) => {
  const { scored, vault, out } = setup(t);
  const calls: { args: string[]; cwd: string }[] = [];
  await main(['--vault', vault, '--scored', scored, '--out', out, '--arms', 'base,screen,screened', '--claude', 'fake-claude'], { runner: fakeClaude(calls, true), log: () => {} });
  assert.equal(calls.length, 5, 'every screen call came back, so screened was judged too');
  const md = readFileSync(path.join(out, 'eval.md'), 'utf8');
  assert.match(md, /^\| base-1 \| 1 \| 1 of 1 \| 0 \| 0 \| 1 \|/m);
  assert.match(md, /^\| screen-1 \| 1 \| 1 of 1 \| 0 \| 0 \| 0 \|/m);
  const totals = JSON.parse(readFileSync(path.join(out, 'eval.json'), 'utf8')).report.totals;
  assert.equal(totals[0].costUsd, 0.02, 'the judge\'s cost is read from the result entry');
  assert.equal(totals[0].outputTokens, 20);
});

// Rule: the ruled arm cards the screen's yes pages in full and asks a line for each of them.
test('the ruled arm asks the judge to rule on each page the screen said yes to', async (t) => {
  const { vault, scored, out } = setup(t);
  const calls: { args: string[]; cwd: string }[] = [];
  await main(['--vault', vault, '--scored', scored, '--out', out, '--arms', 'base,screen,ruled', '--claude', 'fake-claude'], { runner: fakeClaude(calls), log: () => {} });
  assert.equal(calls.filter((c) => !c.args.includes('--max-turns')).length, 2, 'base and ruled each judged once');
  const ruled = readFileSync(path.join(out, 'packets', 'ruled-1', '01-gale-log.md'), 'utf8');
  assert.match(ruled, /^1 in full and 2 by name only\./m, 'only the screen\'s yes page is full');
  assert.match(ruled, /^## Pages to rule on \(1\)\n\n.+\n\n- \[\[Net-Loft\]\]\n/m);
  assert.match(readFileSync(path.join(out, 'eval.md'), 'utf8'), /^\| ruled-1 \| 1 \| 1 of 1 \|/m);
});
