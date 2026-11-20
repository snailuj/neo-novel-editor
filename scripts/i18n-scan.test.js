'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

// Rule: every t('…') string in code that NEO shows, the store module included, is found by
// the scan, so `node scripts/i18n.js template` keeps it for translators.
const ROOT = path.join(__dirname, '..');
const { collect } = require('./i18n.js');
const call = /(?<![\w$.])(?:NeoI18n\.)?tk?\(\s*'((?:[^'\\\n]|\\.)*)'/g;

test('the scan finds every string the store module shows, and the template holds them', () => {
  const dir = path.join(ROOT, 'src', 'store');
  const wanted = new Set();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(call)) wanted.add(m[1]);
  }
  assert.ok(wanted.size >= 4, 'the store shows strings (the catalog, the first shelf)');
  const keys = collect();
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', '_template.json'), 'utf8'));
  for (const k of wanted) {
    assert.ok(keys.has(k), `the scan misses ${k}`);
    assert.ok(k in template, `the template misses ${k}`);
  }
});
