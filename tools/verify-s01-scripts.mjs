#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const root = realpathSync(path.resolve(argument('--root') ?? path.join(import.meta.dirname, '..')));
const fail = (message) => { throw new Error(`S01_SCRIPT_INTERFACE_FAILED: ${message}`); };
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const classification = readJson('migration/package-classification.json');
const pathRepairs = readJson('migration/path-repairs.json');
const baselines = readJson('migration/baselines.json');

function canonicalize(input) {
  let current = input;
  const seen = new Set([current]);
  for (const move of pathRepairs.moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) {
      current = `${move.to}${current.slice(move.from.length)}`;
      if (seen.has(current)) fail(`path-repair cycle while canonicalizing ${input}: ${current}`);
      seen.add(current);
    }
  }
  return current;
}

function walkManifests(directory, output = []) {
  const skipped = new Set(['.git', 'node_modules', '.turbo', '.cache', 'coverage', 'dist']);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkManifests(absolute, output);
    else if (entry.name === 'package.json') output.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return output;
}

const records = classification.manifests.map((record) => ({ ...record, currentPath: canonicalize(record.path) }));
const byName = new Map();
const byPath = new Map();
for (const record of records) {
  if (byName.has(record.finalName)) fail(`duplicate classified name: ${record.finalName}`);
  if (byPath.has(record.currentPath)) fail(`duplicate classified path: ${record.currentPath}`);
  if (!existsSync(path.join(root, record.currentPath))) fail(`missing classified manifest: ${record.currentPath}`);
  byName.set(record.finalName, record);
  byPath.set(record.currentPath, record);
}

const discovered = walkManifests(root).sort();
const expected = ['package.json', ...records.map((record) => record.currentPath)].sort();
if (JSON.stringify(discovered) !== JSON.stringify(expected)) {
  fail(`manifest inventory mismatch\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(discovered)}`);
}

const manifests = new Map(expected.map((manifestPath) => [manifestPath, readJson(manifestPath)]));
const scriptAt = (record, name) => manifests.get(record.currentPath).scripts?.[name];
const requireScript = (record, name, reason) => {
  const command = scriptAt(record, name);
  if (typeof command !== 'string' || command.trim() === '') fail(`${record.currentPath} requires ${name}: ${reason}`);
  return command;
};

const sourceToRecord = (source) => {
  if (source.startsWith('sample-app-')) {
    const framework = source.slice('sample-app-'.length);
    const manifestPath = `frameworks/${framework}/examples/sample-app/package.json`;
    const record = byPath.get(manifestPath);
    if (!record) fail(`baseline source ${source} has no classified sample app at ${manifestPath}`);
    return record;
  }
  const record = byName.get(`@uirouter/${source}`);
  if (!record) fail(`baseline source ${source} has no classified published package`);
  return record;
};

const laneSources = (lane) => [...new Set(baselines.entries
  .filter((entry) => entry.lane === lane && entry.id.includes('.root.'))
  .map((entry) => entry.source))].sort();

for (const source of laneSources('build')) requireScript(sourceToRecord(source), 'build', `B03 ${source}.root.build`);
for (const source of laneSources('unit')) {
  const record = sourceToRecord(source);
  requireScript(record, 'test', `B03 ${source}.root.unit`);
  requireScript(record, 'test:watch', 'source-linked development requires a persistent watch interface');
}
for (const source of laneSources('docs')) requireScript(sourceToRecord(source), 'docs', `B03 ${source}.root.docs`);
for (const source of laneSources('e2e')) requireScript(sourceToRecord(source), 'e2e', `B03 ${source}.root.e2e`);

const angularjs = byName.get('@uirouter/angularjs');
requireScript(angularjs, 'typecheck', 'AngularJS static checking must be independently runnable');
if (/(?:^|\s|&&|\|\|)tsc(?:\s|$)/.test(requireScript(angularjs, 'test', 'B03 angularjs.root.unit'))) {
  fail(`${angularjs.currentPath} test must not run the independent typecheck lane`);
}

const forbiddenUnitPattern = /(?:^|\s|&&|\|\|)(?:npm\s+run\s+)?(?:build|compile|bundle|typecheck|e2e)(?:\s|$)|(?:npm|npx)\s+(?:i|install|ci)(?:\s|$)|(?:playwright\s+test|cypress(?:-runner)?\s+(?:run|open))/i;
const browserKinds = [
  {
    name: 'Playwright',
    execute: /(?:playwright|npx\s+playwright|npm\s+exec\s+--\s+playwright)\s+test\b/i,
    install: /(?:playwright|npx\s+playwright|npm\s+exec\s+--\s+playwright)\s+install\b/i,
  },
  {
    name: 'Cypress',
    execute: /(?:cypress-runner|cypress)\s+(?:run|open)\b/i,
    install: /(?:cypress|npm\s+exec\s+--\s+cypress)\s+install\b/i,
  },
];
const anyBrowserInstall = new RegExp(browserKinds.map((kind) => kind.install.source).join('|'), 'i');
let browserProjects = 0;
let publishedWithTests = 0;

for (const record of records) {
  const manifest = manifests.get(record.currentPath);
  const scripts = manifest.scripts ?? {};
  if (record.published && scripts.test) {
    publishedWithTests += 1;
    if (forbiddenUnitPattern.test(scripts.test)) {
      fail(`${record.currentPath} published-package test is not a source-only unit lane: ${scripts.test}`);
    }
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (name !== 'setup:browser' && anyBrowserInstall.test(command)) {
      fail(`${record.currentPath} embeds browser installation in ${name}: ${command}`);
    }
  }
  const usedBrowserKinds = browserKinds.filter((kind) => Object.values(scripts).some((command) => kind.execute.test(command)));
  if (usedBrowserKinds.length > 0) {
    browserProjects += 1;
    const setup = requireScript(record, 'setup:browser', `${usedBrowserKinds.map((kind) => kind.name).join('/')} execution requires explicit browser setup`);
    requireScript(record, 'e2e', `${usedBrowserKinds.map((kind) => kind.name).join('/')} execution requires a canonical e2e lane`);
    for (const kind of usedBrowserKinds) {
      if (!kind.install.test(setup)) fail(`${record.currentPath} setup:browser does not install ${kind.name}: ${setup}`);
    }
  }
}

for (const packageName of ['@uirouter/angular-hybrid', '@uirouter/react-hybrid']) {
  const record = byName.get(packageName);
  if (scriptAt(record, 'test')) fail(`${record.currentPath} has no real unit suite and must not alias test to build`);
}

const publishedConsumers = new Set(records.filter((record) => record.published && scriptAt(record, 'test')).map((record) => record.currentPath));
const deferredConsumers = new Set();
for (const edge of classification.edges) {
  if (edge.resolutionMode !== 'workspace') continue;
  const consumerPath = canonicalize(edge.consumerManifest);
  if (publishedConsumers.has(consumerPath)) deferredConsumers.add(consumerPath);
}

const roleCounts = Object.fromEntries(['published-package', 'example', 'integration', 'nested-tool']
  .map((role) => [role, records.filter((record) => record.class === role).length]));
console.log(`S01_SCRIPT_INTERFACE_OK manifests=${discovered.length} published=${roleCounts['published-package']} publishedTests=${publishedWithTests} examples=${roleCounts.example} integrations=${roleCounts.integration} nestedTools=${roleCounts['nested-tool']} browserProjects=${browserProjects}`);
console.log(`S01_SOURCE_LINKED_DEFERRED task=S02 consumers=${deferredConsumers.size} paths=${[...deferredConsumers].sort().join(',')}`);
