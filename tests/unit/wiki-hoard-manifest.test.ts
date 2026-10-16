// Rules for knowing what hoard already holds:
// - an old vault's root is the nearest folder above a page that holds .obsidian or .git;
// - hoard's root is the nearest folder above one of its pages that holds
//   _meta/MANIFEST.jsonl, and hoard is found from any page that came from it;
// - a page whose vault path and bytes hoard's manifest records is held by hoard, also
//   when hoard recorded it under another path or as a git source; one whose path it
//   records with other bytes is an older copy; any other page, and every page inside
//   hoard itself, is not hoard's;
// - a manifest that does not read is reported, and then nothing counts as hoard's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HoardIndex, hoardRoot, vaultRoot } from '../../src/hoard/wiki/hoard-manifest.ts';
import { tempDir } from './git-support.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function put(file: string, text: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

function scene(t: { after(fn: () => void): void }) {
  const root = tempDir(t, 'hoard-oldvault-');
  const vault = path.join(root, 'old vault');
  const hoard = path.join(root, 'hoard');
  mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  const record = (src: string, text: string, extra = {}) => JSON.stringify({ src, dest: 'lore/x.md', method: 'verbatim', src_sha256: sha(text), ...extra });
  put(path.join(hoard, '_meta', 'MANIFEST.jsonl'), [
    record('20_Atoms/Harbour.md', 'harbour v1'),
    record('Writing/Quay.md', 'quay as it was'),
    record('git:old-vault@c56027f:Writing/_db/char_kell.md', 'kell'),
    record('drive:abc123', 'moved bytes'),
    JSON.stringify({ dest: 'lore/gone.md', method: 'retire', successor: null, reason: 'r', retired_at: 'now' }),
  ].join('\n') + '\n');
  const hoardPage = put(path.join(hoard, 'lore', 'Harbour.md'), 'harbour in hoard');
  return { vault, hoard, hoardPage };
}

test('the vault root is the nearest folder above a page holding .obsidian or .git', (t) => {
  const { vault, hoard, hoardPage } = scene(t);
  assert.equal(vaultRoot(path.join(vault, '20_Atoms', 'deep', 'Harbour.md')), vault);
  mkdirSync(path.join(hoard, '.git'));
  assert.equal(vaultRoot(hoardPage), hoard);
  assert.equal(vaultRoot(path.join(path.parse(vault).root, 'nowhere-at-all', 'x.md')), null);
});

test('hoard is found from any page that came from it', (t) => {
  const { vault, hoard, hoardPage } = scene(t);
  assert.equal(hoardRoot(hoardPage), hoard);
  assert.equal(hoardRoot(path.join(vault, 'Writing', 'Quay.md')), null);
});

test('a page hoard recorded with the same bytes is held by hoard, with other bytes an older copy', (t) => {
  const { vault, hoard } = scene(t);
  const index = HoardIndex.read([hoard], () => {});
  assert.equal(index.problems.length, 0);
  const at = (rel: string) => path.join(vault, ...rel.split('/'));
  assert.equal(index.verdict(at('20_Atoms/Harbour.md'), sha('harbour v1')), 'through-hoard');
  assert.equal(index.verdict(at('20_Atoms/Harbour.md'), sha('harbour v2')), 'hoard-older');
  assert.equal(index.verdict(at('Writing/_db/char_kell.md'), sha('kell')), 'through-hoard');
  assert.equal(index.verdict(at('Elsewhere/Renamed.md'), sha('moved bytes')), 'through-hoard');
  assert.equal(index.verdict(at('Writing/New.md'), sha('new')), null);
  assert.equal(index.verdict(path.join(hoard, 'lore', 'Kell.md'), sha('kell')), null, 'hoard\'s own page is never hoard\'s source');
  assert.equal(index.verdict(path.join(path.parse(vault).root, 'no-vault-here', 'x.md'), sha('kell')), 'through-hoard');
  assert.equal(index.verdict(path.join(path.parse(vault).root, 'no-vault-here', 'y.md'), sha('y')), null);
});

test('a hoard manifest that does not read is reported, and then nothing counts as hoard\'s', (t) => {
  const { vault, hoard } = scene(t);
  writeFileSync(path.join(hoard, '_meta', 'MANIFEST.jsonl'), '{"dest": "a", "method": "rename"}\nnot json\n');
  const lines: string[] = [];
  const index = HoardIndex.read([hoard], (_level, message) => { lines.push(message); });
  assert.equal(index.problems.length, 1);
  assert.match(index.problems[0]!, /line 2/);
  assert.ok(lines.some((l) => /MANIFEST/.test(l)));
  assert.equal(index.verdict(path.join(vault, '20_Atoms', 'Harbour.md'), sha('harbour v1')), null);
});
