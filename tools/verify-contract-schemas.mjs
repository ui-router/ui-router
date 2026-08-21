#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = path.join(repository, 'migration', 'schemas');
const filenames = (await readdir(schemaDirectory)).filter((name) => name.endsWith('.schema.json')).sort();
if (filenames.length === 0) fail('No migration contract schemas found');
const schemas = new Map();
const ids = new Set();
for (const filename of filenames) {
  const schema = JSON.parse(await readFile(path.join(schemaDirectory, filename), 'utf8'));
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail(`${filename} does not declare JSON Schema 2020-12`);
  if (typeof schema.$id !== 'string' || ids.has(schema.$id)) fail(`${filename} has a missing or duplicate $id`);
  ids.add(schema.$id);
  schemas.set(filename, schema);
}

function pointerValue(document, pointer, label) {
  if (!pointer || pointer === '#') return document;
  if (!pointer.startsWith('#/')) fail(`${label} uses an unsupported JSON pointer`);
  let current = document;
  for (const encoded of pointer.slice(2).split('/')) {
    const component = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !(component in current)) fail(`${label} points to missing ${pointer}`);
    current = current[component];
  }
  return current;
}

function visit(node, filename, location = '#') {
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string') {
    const [referencedFile, fragment = ''] = node.$ref.split('#', 2);
    const targetFilename = referencedFile || filename;
    const target = schemas.get(targetFilename);
    if (!target) fail(`${filename}${location} references missing schema ${targetFilename}`);
    pointerValue(target, fragment ? `#${fragment}` : '#', `${filename}${location}`);
  }
  for (const [key, value] of Object.entries(node)) visit(value, filename, `${location}/${key}`);
}
for (const [filename, schema] of schemas) visit(schema, filename);

console.log(`CONTRACT_SCHEMAS_OK schemas=${schemas.size}`);
