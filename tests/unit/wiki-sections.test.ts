// Rule for cutting a section out of a Markdown page: a section is its heading line and
// every line after it up to the next heading of the same or a higher level; a `#` line
// inside a code fence is no heading, and a heading the page lacks gives nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headings, section } from '../../src/hoard/wiki/sections.ts';

const page = [
  '# Tide',
  'Intro line.',
  '## Overview',
  'The era.',
  '### Peoples',
  'Boat folk.',
  '```',
  '## not a heading',
  '```',
  '## Tasks',
  '- [ ] a task',
  '## Overview',
  'A second overview.',
  '# Filing ##',
  'Where it went.',
].join('\n');

test('a section runs from its heading to the next heading of the same or a higher level', () => {
  assert.equal(section(page, 'Overview'), '## Overview\nThe era.\n### Peoples\nBoat folk.\n```\n## not a heading\n```');
  assert.equal(section(page, 'Peoples'), '### Peoples\nBoat folk.\n```\n## not a heading\n```');
  assert.equal(section(page, 'Tasks'), '## Tasks\n- [ ] a task');
  assert.equal(section(page, 'Tide'), page.split('\n# Filing')[0]);
  assert.equal(section(page, 'Filing'), '# Filing ##\nWhere it went.');
});

test('a heading is found without regard to case when no heading matches exactly, and a missing one gives null', () => {
  assert.equal(section(page, 'tasks'), '## Tasks\n- [ ] a task');
  assert.equal(section(page, 'not a heading'), null);
  assert.equal(section(page, 'Nowhere'), null);
});

test('headings lists every heading outside a fence, with its level', () => {
  assert.deepEqual(headings(page).map((h) => [h.level, h.text]), [
    [1, 'Tide'], [2, 'Overview'], [3, 'Peoples'], [2, 'Tasks'], [2, 'Overview'], [1, 'Filing'],
  ]);
});

test('a fence closes only on its own marker, at least as long as the one that opened it', () => {
  const body = ['# Top', '````', '~~~', '# not a heading', '```', '## nor this', '````', '## Next', 'After.'].join('\n');
  assert.deepEqual(headings(body).map((h) => h.text), ['Top', 'Next']);
  assert.equal(section(body, 'Next'), '## Next\nAfter.');
});
