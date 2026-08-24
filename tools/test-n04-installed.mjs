#!/usr/bin/env node
import { mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  run(/edge-framework-angular-examples-sample-app-dependencies-uirouter-core: workspace physical origin .* != .*\/installed\/core|edge-framework-angular-hybrid-examples-example-dependencies-uirouter-core: workspace physical origin/, 'workspace-registry-fallback'); passed += 1;
} finally {
  rmSync(workspaceLink, { force: true });
  symlinkSync(workspaceTarget, workspaceLink);
}

const installedWorkspace = path.join(installedRoot, 'core');
const installedWorkspaceBackup = path.join(installedRoot, '.n04-original-core-workspace');
renameSync(installedWorkspace, installedWorkspaceBackup);
try {
  symlinkSync(path.join(repository, 'core'), installedWorkspace);
  run(/edge-core-devdependencies-uirouter-publish-scripts consumer: directory is a symbolic link: .*\/core/, 'workspace-consumer-escape'); passed += 1;
} finally {
  rmSync(installedWorkspace, { force: true });
  renameSync(installedWorkspaceBackup, installedWorkspace);
}

const installedTarget = path.join(installedRoot, 'plugins/rx');
const installedTargetBackup = path.join(installedRoot, 'plugins/.n04-original-rx-workspace');
renameSync(installedTarget, installedTargetBackup);
try {
  symlinkSync(path.join(repository, 'plugins/rx'), installedTarget);
  run(/edge-framework-angular-hybrid-examples-example-dependencies-uirouter-rx: directory is a symbolic link: .*\/plugins\/rx/, 'workspace-target-escape'); passed += 1;
} finally {
  rmSync(installedTarget, { force: true });
  renameSync(installedTargetBackup, installedTarget);
}

const localPackage = path.join(installedRoot, 'core/integration-tests/typescript-3.9/node_modules/@uirouter/core');
const backup = `${localPackage}.n04-original`;
renameSync(localPackage, backup);
try {
  symlinkSync(path.join(installedRoot, 'core'), localPackage);
  run(/edge-core-integration-typescript-3-9-dependencies-uirouter-core: local dependency is a symbolic link: .*typescript-3\.9\/node_modules\/@uirouter\/core/, 'local-workspace-link'); passed += 1;
} finally {
  rmSync(localPackage, { force: true });
  renameSync(backup, localPackage);
}

renameSync(localPackage, backup);
try {
  run(/edge-core-integration-typescript-3-9-dependencies-uirouter-core: installed local consumer has no @uirouter\/core/, 'local-missing-package'); passed += 1;
} finally {
  renameSync(backup, localPackage);
}

const legacyOnlyPackage = path.join(installedRoot, 'frameworks/react/integration-tests/react17/node_modules/@uirouter/react');
mkdirSync(legacyOnlyPackage, { recursive: true });
try {
  writeFileSync(path.join(legacyOnlyPackage, 'package.json'), '{"name":"@uirouter/react","version":"1.0.8"}\n');
  run(/edge-framework-react-integration-react17-legacy-injected-uirouter-react-react-versions-react17: forbidden legacy-only package present in baseline: .*node_modules\/@uirouter\/react/, 'legacy-only-baseline-injection'); passed += 1;
} finally {
  rmSync(legacyOnlyPackage, { recursive: true, force: true });
}

const nestedLegacyOnlyPackage = path.join(installedRoot, 'frameworks/react/integration-tests/react17/node_modules/react/node_modules/@uirouter/react');
mkdirSync(nestedLegacyOnlyPackage, { recursive: true });
try {
  writeFileSync(path.join(nestedLegacyOnlyPackage, 'package.json'), '{"name":"@uirouter/react","version":"1.0.8"}\n');
  run(/edge-framework-react-integration-react17-legacy-injected-uirouter-react-react-versions-react17: forbidden legacy-only package present in baseline: .*node_modules\/react\/node_modules\/@uirouter\/react/, 'nested-legacy-only-injection'); passed += 1;
} finally {
  rmSync(path.join(installedRoot, 'frameworks/react/integration-tests/react17/node_modules/react'), { recursive: true, force: true });
}

mkdirSync(path.dirname(legacyOnlyPackage), { recursive: true });
symlinkSync('/n04-deliberately-missing', legacyOnlyPackage);
try {
  run(/edge-framework-react-integration-react17-legacy-injected-uirouter-react-react-versions-react17: forbidden legacy-only package present in baseline: .*node_modules\/@uirouter\/react/, 'dangling-legacy-only-symlink'); passed += 1;
} finally {
  rmSync(legacyOnlyPackage, { force: true });
}

const installedLockPath = path.join(installedRoot, 'core/integration-tests/typescript-3.9/node_modules/.package-lock.json');
const installedLockBytes = readFileSync(installedLockPath);
try {
  const installedLock = JSON.parse(installedLockBytes);
  installedLock.packages['node_modules/@uirouter/core'].resolved = 'https://registry.npmjs.org/@uirouter/react/-/react-6.1.2.tgz';
  writeFileSync(installedLockPath, `${JSON.stringify(installedLock, null, 2)}\n`);
  run(/edge-core-integration-typescript-3-9-dependencies-uirouter-core: installed resolved differs from committed registry baseline/, 'installed-lock-origin'); passed += 1;
} finally {
  writeFileSync(installedLockPath, installedLockBytes);
}

const reactInstalledLockPath = path.join(installedRoot, 'frameworks/react/integration-tests/react17/node_modules/.package-lock.json');
const reactInstalledLockBytes = readFileSync(reactInstalledLockPath);
try {
  const installedLock = JSON.parse(reactInstalledLockBytes);
  installedLock.packages['node_modules/react/node_modules/@uirouter/react'] = {
    version: '1.0.8',
    resolved: 'https://registry.npmjs.org/@uirouter/react/-/react-1.0.8.tgz',
    integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  };
  writeFileSync(reactInstalledLockPath, `${JSON.stringify(installedLock, null, 2)}\n`);
  run(/edge-framework-react-integration-react17-legacy-injected-uirouter-react-react-versions-react17: forbidden legacy-only package present in baseline/, 'nested-legacy-only-lock'); passed += 1;
} finally {
  writeFileSync(reactInstalledLockPath, reactInstalledLockBytes);
}

run(null, 'restored-control'); passed += 1;
console.log(`N04_INSTALLED_ADVERSARIAL_TESTS_OK cases=${passed}`);
