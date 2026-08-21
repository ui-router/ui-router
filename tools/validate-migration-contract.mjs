#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CONTRACT_VALIDATOR_NAME = 'ui-router-contract-validator';
export const CONTRACT_VALIDATOR_VERSION = '1';

function fail(message) {
  throw new Error(message);
}

function usage() {
  return `Usage: node tools/validate-migration-contract.mjs --schema <schema.json> --data <contract.json>\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (['--schema', '--data'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      options[argument.slice(2)] = path.resolve(value);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (!options.schema) fail('--schema is required');
  if (!options.data) fail('--data is required');
  return options;
}

function decodePointerComponent(value) {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function pointerValue(document, fragment, label) {
  if (!fragment || fragment === '#') return document;
  if (!fragment.startsWith('#/')) fail(`${label} uses unsupported JSON pointer ${fragment}`);
  let current = document;
  for (const encoded of fragment.slice(2).split('/')) {
    const component = decodePointerComponent(encoded);
    if (current === null || typeof current !== 'object' || !(component in current)) {
      fail(`${label} references missing JSON pointer ${fragment}`);
    }
    current = current[component];
  }
  return current;
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return valueType(value) === expected;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidUri(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return Boolean(url.protocol);
  } catch {
    return false;
  }
}

async function loadSchema(filename, cache) {
  const resolved = path.resolve(filename);
  if (!cache.has(resolved)) cache.set(resolved, JSON.parse(await readFile(resolved, 'utf8')));
  return cache.get(resolved);
}

async function validateNode(value, schema, context, instancePath, schemaPath) {
  const errors = [];
  const add = (message) => errors.push(`${instancePath}: ${message} (${schemaPath})`);
  if (typeof schema === 'boolean') {
    if (!schema) add('value is rejected by boolean schema');
    return errors;
  }
  if (!schema || typeof schema !== 'object') {
    add('schema node is not an object or boolean');
    return errors;
  }

  if (schema.$ref) {
    const [referenceFile, referenceFragment = ''] = schema.$ref.split('#', 2);
    const targetFile = referenceFile ? path.resolve(path.dirname(context.schemaFile), referenceFile) : context.schemaFile;
    const targetDocument = await loadSchema(targetFile, context.cache);
    const targetSchema = pointerValue(targetDocument, referenceFragment ? `#${referenceFragment}` : '#', `${schemaPath}/$ref`);
    return validateNode(value, targetSchema, { ...context, schemaFile: targetFile }, instancePath, `${targetFile}${referenceFragment ? `#${referenceFragment}` : '#'}`);
  }

  if (schema.allOf) {
    for (const [index, child] of schema.allOf.entries()) {
      errors.push(...await validateNode(value, child, context, instancePath, `${schemaPath}/allOf/${index}`));
    }
  }
  if (schema.anyOf) {
    const attempts = await Promise.all(schema.anyOf.map((child, index) => (
      validateNode(value, child, context, instancePath, `${schemaPath}/anyOf/${index}`)
    )));
    if (!attempts.some((attempt) => attempt.length === 0)) add('value matches no anyOf branch');
  }
  if (schema.oneOf) {
    const attempts = await Promise.all(schema.oneOf.map((child, index) => (
      validateNode(value, child, context, instancePath, `${schemaPath}/oneOf/${index}`)
    )));
    const matches = attempts.filter((attempt) => attempt.length === 0).length;
    if (matches !== 1) add(`value must match exactly one oneOf branch; matched ${matches}`);
  }
  if (schema.not) {
    const attempt = await validateNode(value, schema.not, context, instancePath, `${schemaPath}/not`);
    if (attempt.length === 0) add('value matches forbidden not schema');
  }
  if (schema.if) {
    const condition = await validateNode(value, schema.if, context, instancePath, `${schemaPath}/if`);
    const selected = condition.length === 0 ? schema.then : schema.else;
    const selectedName = condition.length === 0 ? 'then' : 'else';
    if (selected) errors.push(...await validateNode(value, selected, context, instancePath, `${schemaPath}/${selectedName}`));
  }

  if ('const' in schema && canonicalJson(value) !== canonicalJson(schema.const)) add(`value differs from const ${canonicalJson(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) {
    add(`value is not in enum ${canonicalJson(schema.enum)}`);
  }
  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expectedTypes.some((expected) => matchesType(value, expected))) {
      add(`expected type ${expectedTypes.join('|')}, got ${valueType(value)}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) add(`string length is below ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) add(`string length exceeds ${schema.maxLength}`);
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) add(`string does not match ${schema.pattern}`);
    if (schema.format === 'date' && !isValidDate(value)) add('string is not an RFC 3339 full-date');
    if (schema.format === 'uri' && !isValidUri(value)) add('string is not an absolute URI');
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) add(`number is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`number exceeds ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`array has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add(`array has more than ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = canonicalJson(item);
        if (seen.has(key)) add('array contains duplicate items');
        seen.add(key);
      }
    }
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        errors.push(...await validateNode(item, schema.items, context, `${instancePath}/${index}`, `${schemaPath}/items`));
      }
    }
    if (schema.contains) {
      let matches = 0;
      for (const [index, item] of value.entries()) {
        const attempt = await validateNode(item, schema.contains, context, `${instancePath}/${index}`, `${schemaPath}/contains`);
        if (attempt.length === 0) matches += 1;
      }
      const minimum = schema.minContains ?? 1;
      const maximum = schema.maxContains ?? Number.POSITIVE_INFINITY;
      if (matches < minimum || matches > maximum) add(`contains matched ${matches}, expected ${minimum}..${maximum}`);
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required) {
      for (const key of schema.required) if (!(key in value)) add(`missing required property ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...await validateNode(value[key], child, context, `${instancePath}/${key}`, `${schemaPath}/properties/${key}`));
    }
    for (const key of Object.keys(value)) {
      if (key in properties) continue;
      if (schema.additionalProperties === false) add(`unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...await validateNode(
          value[key], schema.additionalProperties, context, `${instancePath}/${key}`, `${schemaPath}/additionalProperties`,
        ));
      }
    }
  }

  return errors;
}

export async function validateJsonSchema(value, schemaFile) {
  const resolvedSchema = path.resolve(schemaFile);
  const cache = new Map();
  const schema = await loadSchema(resolvedSchema, cache);
  const errors = await validateNode(value, schema, { cache, schemaFile: resolvedSchema }, '$', `${resolvedSchema}#`);
  if (errors.length > 0) fail(`Contract schema validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const value = JSON.parse(await readFile(options.data, 'utf8'));
  await validateJsonSchema(value, options.schema);
  console.log(`CONTRACT_VALID ${path.relative(process.cwd(), options.data)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
