// The one walk over schemas/, shared by gen.mjs and build.mjs.
// Every *.json under the schemas directory is a schema, in sorted order. Each gets a
// type name and a validator name from its file name: hoard-ping-v1.json is HoardPingV1,
// so validateHoardPingV1 and the type HoardPingV1.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export function pascalCase(fileName) {
  return fileName
    .replace(/\.json$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

async function jsonFiles(dir, prefix = '') {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const found = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await jsonFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.json')) found.push(rel);
  }
  return found;
}

// Returns [{file, name, schema}]; `file` is the posix path relative to the schemas
// directory. Two schemas that map to one name would clash in validators.cjs, so that throws.
export async function walkSchemas(schemasDir) {
  const schemas = [];
  const seen = new Map();
  for (const file of await jsonFiles(schemasDir)) {
    const name = pascalCase(path.posix.basename(file));
    if (seen.has(name)) throw new Error(`${file} and ${seen.get(name)} both map to ${name}`);
    seen.set(name, file);
    const text = await readFile(path.join(schemasDir, file), 'utf8');
    try {
      schemas.push({ file, name, schema: JSON.parse(text) });
    } catch (cause) {
      throw new Error(`${file} is not valid JSON`, { cause });
    }
  }
  return schemas;
}
