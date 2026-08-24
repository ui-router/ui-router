#!/usr/bin/env node
import { readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const repository = path.resolve(import.meta.dirname, '..');
const flag = process.argv.indexOf('--installed-root');
if (flag === -1 || !process.argv[flag + 1]) throw new Error('usage: node tools/test-n04-installed.mjs --installed-root <disposable-install>');
const installedRoot = path.resolve(process.argv[flag + 1]);
if (installedRoot === repository || installedRoot.startsWith(`${repository}${path.sep}`) || repository.startsWith(`${installedRoot}${path.sep}`)) throw new Error('--installed-root must be a disposable tree outside repository ancestry');

function run(expected, label) {
  const result = spawnSync(process.execPath, ['tools/verify-internal-deps.mjs', '--installed-root', installedRoot], { cwd: repository, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  if (expected === null) {
    if (result.status !== 0 || !/installed=verified/.test(output)) throw new Error(`${label}: positive installed proof failed:\n${output}`);
  } else if (result.status === 0 || !expected.test(output)) {
    throw new Error(`${label}: expected ${expected}, got:\n${output}`);
  }
}

let passed = 0;
run(null, 'positive-control'); passed += 1;

const workspaceLink = path.join(installedRoot, 'node_modules/@uirouter/core');
const workspaceTarget = readlinkSync(workspaceLink);
rmSync(workspaceLink);
try {
  symlinkSync(path.join(installedRoot, 'core/integration-tests/typescript-3.9/node_modules/@uirouter/core'), workspaceLink);
  run(/npm ls internal root problem.*@uirouter\/core|workspace physical origin .* != /, 'workspace-registry-fallback'); passed += 1;
} finally {
  rmSync(workspaceLink, { force: true });
  symlinkSync(workspaceTarget, workspaceLink);
}

const localPackage = path.join(installedRoot, 'core/integration-tests/typescript-3.9/node_modules/@uirouter/core');
const backup = `${localPackage}.n04-original`;
renameSync(localPackage, backup);
try {
  symlinkSync(path.join(installedRoot, 'core'), localPackage);
  run(/npm ls internal|local dependency is a symbolic link|local dependency realpath/, 'local-workspace-link'); passed += 1;
} finally {
  rmSync(localPackage, { force: true });
  renameSync(backup, localPackage);
}

renameSync(localPackage, backup);
try {
  run(/npm ls internal|npm ls omitted|required internal|installed local consumer has no/, 'local-missing-package'); passed += 1;
} finally {
  renameSync(backup, localPackage);
}

const installedLockPath = path.join(installedRoot, 'core/integration-tests/typescript-3.9/node_modules/.package-lock.json');
const installedLockBytes = readFileSync(installedLockPath);
try {
  const installedLock = JSON.parse(installedLockBytes);
  installedLock.packages['node_modules/@uirouter/core'].resolved = 'https://registry.npmjs.org/@uirouter/react/-/react-6.1.2.tgz';
  writeFileSync(installedLockPath, `${JSON.stringify(installedLock, null, 2)}\n`);
  run(/installed resolved differs from committed registry baseline/, 'installed-lock-origin'); passed += 1;
} finally {
  writeFileSync(installedLockPath, installedLockBytes);
}

run(null, 'restored-control'); passed += 1;
console.log(`N04_INSTALLED_ADVERSARIAL_TESTS_OK cases=${passed}`);
