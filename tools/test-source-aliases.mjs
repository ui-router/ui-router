#!/usr/bin/env node
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const verifier = path.join(repository, 'tools/verify-source-aliases.mjs');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'uirouter-s02-contract-'));
const copyFile = (relative) => {
  const destination = path.join(fixture, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(path.join(repository, relative), destination);
};

for (const relative of [
  'migration/source-aliases.json',
  'migration/package-classification.json',
  'migration/path-repairs.json',
  'migration/baselines.json',
  'migration/schemas/source-aliases.schema.json',
  'migration/schemas/contract-common.schema.json',
]) copyFile(relative);

const contract = JSON.parse(readFileSync(path.join(repository, 'migration/source-aliases.json'), 'utf8'));
const classification = JSON.parse(readFileSync(path.join(repository, 'migration/package-classification.json'), 'utf8'));
const repairs = JSON.parse(readFileSync(path.join(repository, 'migration/path-repairs.json'), 'utf8'));
const canonicalize = (input) => {
  let current = input;
  for (const move of repairs.moves) if (current === move.from || current.startsWith(`${move.from}/`)) current = `${move.to}${current.slice(move.from.length)}`;
  return current;
};
const consumerManifests = new Set(contract.edges.map((edge) => edge.consumer));
consumerManifests.add('core/package.json');
for (const record of classification.manifests.filter((candidate) => candidate.published)) consumerManifests.add(canonicalize(record.path));
for (const relative of consumerManifests) copyFile(relative);
for (const edge of contract.edges) copyFile(edge.sourceEntrypoint);

const sourceRoots = ['core', 'frameworks/angular/uirouter-angular', 'frameworks/angularjs/uirouter-angularjs', 'frameworks/react/uirouter-react', 'plugins/dsr', 'plugins/redux', 'plugins/rx', 'plugins/sticky-states'];
const sourceDirectories = new Set(['src', 'test', 'test-zoneless', 'core', 'react']);
const extensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
function copySources(packageRoot) {
  const walk = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'lib', 'lib-esm', '_bundles', 'coverage', 'examples', 'angular'].includes(entry.name)) continue;
      const child = path.join(absolute, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child, childRelative);
      else if (extensions.has(path.extname(entry.name))) copyFile(childRelative.split(path.sep).join('/'));
    }
  };
  for (const name of sourceDirectories) {
    const absolute = path.join(repository, packageRoot, name);
    if (existsSync(absolute)) walk(absolute, path.join(packageRoot, name));
  }
}
for (const packageRoot of sourceRoots) copySources(packageRoot);

const contractPath = path.join(fixture, 'migration/source-aliases.json');
const original = readFileSync(contractPath, 'utf8');
function run() {
  return spawnSync(process.execPath, [verifier, '--root', fixture, '--contract-only'], { encoding: 'utf8' });
}
function mutate(callback) {
  const value = JSON.parse(original);
  callback(value);
  writeFileSync(contractPath, `${JSON.stringify(value, null, 2)}\n`);
}

const positive = run();
if (positive.status !== 0) throw new Error(`positive contract validation failed:\n${positive.stdout}\n${positive.stderr}`);
const cases = [
  ['omitted derived edge', (value) => value.edges.shift(), 'contract differs from independently derived imports'],
  ['duplicate edge id', (value) => { value.edges[1].id = value.edges[0].id; }, 'duplicate edge id'],
  ['duplicate semantic key', (value) => { value.edges[1] = { ...value.edges[0], id: 'different-id' }; }, 'duplicate semantic edge'],
  ['wrong exact source entrypoint', (value) => { value.edges[0].sourceEntrypoint = 'core/src/router.ts'; value.edges[0].expectedRealpath = 'core/src/router.ts'; }, 'contract differs from independently derived imports'],
  ['wrong adapter ownership', (value) => { value.edges[0].adapters.jest = value.edges[0].adapters.vitest; value.edges[0].adapters.vitest = 'not-applicable'; }, 'adapter ownership expected'],
  ['wrong root precedence', (value) => { value.edges.find((edge) => edge.export === '.').precedence = 10; }, 'root precedence must be 100'],
  ['wrong classification evidence', (value) => { value.edges[0].evidence.sha256 = '0'.repeat(64); }, 'evidence does not bind the classification'],
  ['watch command targets another edge', (value) => { const argv = value.edges[0].invalidationCommand.argv; argv[argv.length - 1] = value.edges[1].id; }, 'invalidation command must target its exact edge'],
];

try {
  for (const [name, callback, expected] of cases) {
    mutate(callback);
    const result = run();
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(expected)) throw new Error(`${name} did not fail as expected (status ${result.status}):\n${output}`);
    writeFileSync(contractPath, original);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
console.log(`S02_CONTRACT_ADVERSARIAL_TESTS_OK cases=${cases.length}`);

const fullFixture = mkdtempSync(path.join(os.tmpdir(), 'uirouter-s02-full-'));
const excludedNames = new Set(['.git', 'node_modules', 'coverage', 'lib', 'lib-esm', '_bundles', 'dist']);
cpSync(repository, fullFixture, {
  recursive: true,
  filter(source) {
    return !excludedNames.has(path.basename(source));
  },
});
symlinkSync(path.join(repository, 'node_modules'), path.join(fullFixture, 'node_modules'), 'dir');
const fullRun = () => spawnSync(process.execPath, [verifier, '--root', fullFixture], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const fullCases = [
  {
    name: 'missing shared TypeScript source compiler',
    file: 'plugins/dsr/vitest.config.ts',
    mutate: (text) => text.replace('plugins: source.plugins', 'plugins: [source.watchPlugin]'),
    expected: 'does not install the shared TypeScript source compiler',
  },
  {
    name: 'bare Vitest watch command',
    file: 'plugins/rx/package.json',
    mutate: (text) => text.replace('"test:watch": "vitest --watch"', '"test:watch": "vitest"'),
    expected: 'must invoke vitest with explicit --watch',
  },
  {
    name: 'modern class transform semantics',
    file: 'tools/source-aliases.cjs',
    mutate: (text) => text.replace('target: ts.ScriptTarget.ES5', 'target: ts.ScriptTarget.ESNext'),
    expected: 'does not preserve legacy enumerable class methods',
  },
  {
    name: 'production config source alias',
    file: 'core/rollup.config.js',
    mutate: (text) => `${text}\n// source-aliases.cjs\n`,
    expected: 'production config loads source aliases',
  },
];

try {
  const positiveFull = fullRun();
  if (positiveFull.status !== 0) throw new Error(`positive full validation failed:\n${positiveFull.stdout}\n${positiveFull.stderr}`);
  for (const testCase of fullCases) {
    const target = path.join(fullFixture, testCase.file);
    const baseline = readFileSync(target, 'utf8');
    const mutated = testCase.mutate(baseline);
    if (mutated === baseline) throw new Error(`${testCase.name} mutation did not change ${testCase.file}`);
    writeFileSync(target, mutated);
    const result = fullRun();
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(testCase.expected)) throw new Error(`${testCase.name} did not fail as expected (status ${result.status}):\n${output}`);
    writeFileSync(target, baseline);
  }
} finally {
  rmSync(fullFixture, { recursive: true, force: true });
}
console.log(`S02_ADAPTER_ADVERSARIAL_TESTS_OK cases=${fullCases.length}`);
