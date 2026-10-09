'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// how a chapter file is laid out on disk (paragraphLines), run on its own
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(app.slice(app.indexOf('function paragraphLines('), app.indexOf('// One write at a time per chapter')), context);
vm.runInContext('this.api = { paragraphLines };', context);
const { paragraphLines } = context.api;

test('each paragraph of a chapter file stands on its own line', () => {
  assert.equal(paragraphLines('<p>a</p><p class="scene-break">***</p><p><br></p>'),
    '<p>a</p>\n<p class="scene-break">***</p>\n<p><br></p>\n');
});

test('a chapter already set one paragraph per line is left as it is', () => {
  const once = paragraphLines('<p>a</p><p class="scene-break">***</p><p><br></p>');
  assert.equal(paragraphLines(once), once);
});

test('a line break inside a paragraph is the paragraph\'s own and stays', () => {
  assert.equal(paragraphLines('<p>a <i>b</i>\nc</p>'), '<p>a <i>b</i>\nc</p>\n');
});

test('blank lines and spaces between paragraphs come down to one line break', () => {
  assert.equal(paragraphLines('<p>a</p>\n\n  <p>b</p>'), '<p>a</p>\n<p>b</p>\n');
});
