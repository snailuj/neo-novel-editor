// Rules for a page's attachments:
// - an attachment is an image or PDF a page embeds or links, as `![[x.png]]`,
//   `![[x.png|300]]`, `[[x.pdf]]` or `![alt](x%20y.png)`; a page embed, a web address
//   and anything in a code fence are not;
// - it is found as Obsidian finds it: the path from the vault's root, then from the
//   page's folder, then by its name anywhere in the vault outside dot-folders;
// - copying keeps its bytes, reuses a copy with the same bytes, and gives a different
//   file under a name already taken a numbered name, inside a tree's attachments folder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AttachmentFinder, attachmentsIn, copyAttachment } from '../../src/hoard/wiki/attachments.ts';
import { tempDir } from './git-support.ts';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function put(file: string, data: string | Buffer): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

test('a page\'s attachments are the images and PDFs it embeds or links, outside code', () => {
  const page = [
    'A map: ![[maps/Harbour Map.png|300]] and ![[Quay.JPG]].',
    'See [[Tide Tables.pdf]], [[Harbour]] and ![[Harbour]] and ![[Harbour#Wall]].',
    '![the wall](images/wall%20north.jpeg) ![remote](https://example.org/x.png) ![t](<sea wall.png>)',
    '```',
    '![[in code.png]]',
    '```',
    'Again ![[Quay.JPG]].',
  ].join('\n');
  assert.deepEqual(attachmentsIn(page), ['maps/Harbour Map.png', 'Quay.JPG', 'Tide Tables.pdf', 'images/wall north.jpeg', 'sea wall.png']);
});

test('an attachment is found from the vault root, then the page\'s folder, then by name', (t) => {
  const vault = tempDir(t, 'hoard-att-');
  mkdirSync(path.join(vault, '.obsidian'));
  const rooted = put(path.join(vault, 'maps', 'Harbour Map.png'), 'root map');
  const near = put(path.join(vault, 'lore', 'maps', 'Harbour Map.png'), 'near map');
  const byName = put(path.join(vault, '_attachments', 'deep', 'Quay.jpg'), 'quay');
  put(path.join(vault, '.trash', 'Lost.png'), 'trashed');
  const page = path.join(vault, 'lore', 'Harbour.md');
  const finder = new AttachmentFinder(vault);
  assert.equal(finder.find('maps/Harbour Map.png', page), rooted);
  assert.equal(finder.find('Harbour Map.png', path.join(vault, 'lore', 'maps', 'x.md')), near);
  assert.equal(finder.find('quay.JPG', page), byName);
  assert.equal(finder.find('Lost.png', page), null);
  assert.equal(finder.find('../../outside.png', page), null);
});

test('copying keeps the bytes, reuses the same bytes, and numbers a different file under a taken name', (t) => {
  const library = tempDir(t, 'hoard-lib-');
  const vault = tempDir(t, 'hoard-att-');
  const a = put(path.join(vault, 'a', 'Map.png'), Buffer.from([0, 1, 2, 255]));
  const b = put(path.join(vault, 'b', 'Map.png'), 'another map');
  const first = copyAttachment(library, 'wiki', a);
  assert.deepEqual(first, { dest: 'wiki/attachments/Map.png', sha256: sha(Buffer.from([0, 1, 2, 255])), copied: true });
  assert.deepEqual(readFileSync(path.join(library, 'wiki', 'attachments', 'Map.png')), Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(copyAttachment(library, 'wiki', a), { ...first, copied: false });
  const second = copyAttachment(library, 'wiki', b);
  assert.deepEqual(second, { dest: 'wiki/attachments/Map (2).png', sha256: sha('another map'), copied: true });
  assert.throws(() => copyAttachment(library, '../x', a), /one name/);
});

// Rule: a page's own vault is searched first; only then each further folder named for
// the import, by path from its top and then by name, in the order named.
test('an attachment the vault lacks is found in the further folders, the vault first', (t) => {
  const vault = tempDir(t, 'hoard-att-');
  const old = tempDir(t, 'hoard-old-');
  mkdirSync(path.join(vault, '.obsidian'));
  const own = put(path.join(vault, 'Quay.jpg'), 'own quay');
  put(path.join(old, 'Media', 'Quay.jpg'), 'old quay');
  const rooted = put(path.join(old, 'Media', 'Cabin.pdf'), 'cabin');
  const byName = put(path.join(old, '_attachments', 'deep', 'Levin.png'), 'levin');
  const page = path.join(vault, 'lore', 'Harbour.md');
  const plain = new AttachmentFinder(vault);
  assert.equal(plain.find('Levin.png', page), null, 'baseline: the vault alone lacks it');
  const finder = new AttachmentFinder(vault, [old]);
  assert.equal(finder.find('Quay.jpg', page), own);
  assert.equal(finder.find('Media/Cabin.pdf', page), rooted);
  assert.equal(finder.find('levin.PNG', page), byName);
  assert.equal(finder.find('Nowhere.png', page), null);
});
