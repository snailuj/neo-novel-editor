'use strict';

// diff.neochapter.textconv: git passes the path of a chapter file; print it
// one paragraph per line. The stored file is not touched.

const fs = require('node:fs');
const { paragraphLines } = require('./neo-lines.js');

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: neo-textconv.js <chapter file>\n');
  process.exit(2);
}
// latin1 in and out keeps every byte as it was
fs.writeSync(1, Buffer.from(paragraphLines(fs.readFileSync(file).toString('latin1')), 'latin1'));
