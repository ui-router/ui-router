#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const verifier = path.join(repository, 'tools/verify-s01-scripts.mjs');
const classification = JSON.parse(readFileSync(path.join(repository, 'migration/package-classification.json'), 'utf8'));
const repairs = JSON.parse(readFileSync(path.join(repository, 'migration/path-repairs.json'), 'utf8'));

function canonicalize(input) {
  let current = input;
  for (const move of repairs.moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) current = `${move.to}${current.slice(move.from.length)}`;
  }
  return current;
}

function copyFile(root, relative) {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(path.join(repository, relative), destination);
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'uirouter-s01-'));
  for (const relative of ['package.json', 'migration/package-classification.json', 'migration/path-repairs.json', 'migration/baselines.json']) copyFile(root, relative);
  for (const record of classification.manifests) copyFile(root, canonicalize(record.path));
  return root;
}

function mutate(root, relative, callback) {
  const file = path.join(root, relative);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  callback(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(root) {
  return spawnSync(process.execPath, [verifier, '--root', root], { encoding: 'utf8' });
}

const positive = run(repository);
if (positive.status !== 0) throw new Error(`positive S01 validation failed:\n${positive.stdout}\n${positive.stderr}`);

const cases = [
  {
    name: 'published test cannot build artifacts',
    path: 'frameworks/angular/uirouter-angular/package.json',
    mutate: (manifest) => { manifest.scripts.test = 'npm run build && vitest run'; },
    expected: 'published-package test is not a source-only unit lane',
  },
  {
    name: 'browser installation must be explicit setup',
    path: 'frameworks/react/examples/sample-app/package.json',
    mutate: (manifest) => { manifest.scripts.e2e = 'playwright install chromium && npm run build && playwright test'; },
    expected: 'embeds browser installation in e2e',
  },
  {
    name: 'unit baseline requires watch interface',
    path: 'plugins/dsr/package.json',
    mutate: (manifest) => { delete manifest.scripts['test:watch']; },
    expected: 'requires test:watch',
  },
  {
    name: 'AngularJS typecheck must stay independent',
    path: 'frameworks/angularjs/uirouter-angularjs/package.json',
    mutate: (manifest) => { manifest.scripts.test = `tsc && ${manifest.scripts.test}`; },
    expected: 'test must not run the independent typecheck lane',
  },
  {
    name: 'build-only hybrid test is forbidden',
    path: 'frameworks/react-hybrid/uirouter-react-hybrid/package.json',
    mutate: (manifest) => { manifest.scripts.test = 'npm run build'; },
    expected: 'published-package test is not a source-only unit lane',
  },
];

for (const testCase of cases) {
  const root = makeFixture();
  try {
    mutate(root, testCase.path, testCase.mutate);
    const result = run(root);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(testCase.expected)) {
      throw new Error(`${testCase.name} did not fail as expected (status ${result.status}):\n${output}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`S01_SCRIPT_ADVERSARIAL_TESTS_OK cases=${cases.length}`);
