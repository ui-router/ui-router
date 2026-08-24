#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};
const requireEqual = (label, actual, expected) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const packageJson = readJson('package.json');
const executionLock = readJson('migration/execution-lock.json');
const expectedNode = executionLock.toolchain.node;
const expectedNpm = executionLock.toolchain.npm;
const expectedWorkspaces = [
  'core',
  'plugins/*',
  'plugins/*/examples/*',
  'frameworks/*/uirouter-*',
  'frameworks/*/examples/*',
  'tools/*',
];

requireEqual('Node runtime', process.version, expectedNode);
requireEqual('npm runtime', execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), expectedNpm);
requireEqual('root private flag', packageJson.private, true);
requireEqual('packageManager', packageJson.packageManager, `npm@${expectedNpm}`);
requireEqual('engines.node', packageJson.engines?.node, expectedNode.replace(/^v/, ''));
requireEqual('engines.npm', packageJson.engines?.npm, expectedNpm);
requireEqual('devEngines.runtime.name', packageJson.devEngines?.runtime?.name, 'node');
requireEqual('devEngines.runtime.version', packageJson.devEngines?.runtime?.version, expectedNode.replace(/^v/, ''));
requireEqual('devEngines.runtime.onFail', packageJson.devEngines?.runtime?.onFail, 'error');
requireEqual('devEngines.packageManager.name', packageJson.devEngines?.packageManager?.name, 'npm');
requireEqual('devEngines.packageManager.version', packageJson.devEngines?.packageManager?.version, expectedNpm);
requireEqual('devEngines.packageManager.onFail', packageJson.devEngines?.packageManager?.onFail, 'error');
requireEqual('.nvmrc', readText('.nvmrc'), `${expectedNode.replace(/^v/, '')}\n`);
requireEqual('.node-version', readText('.node-version'), `${expectedNode.replace(/^v/, '')}\n`);
requireEqual('workspaces', JSON.stringify(packageJson.workspaces), JSON.stringify(expectedWorkspaces));

const npmrcLines = readText('.npmrc')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
if (!npmrcLines.includes('ignore-scripts=true')) fail('.npmrc must set ignore-scripts=true');

const rootLockPresent = existsSync(join(root, 'package-lock.json'));
const lockVerifierEnabled = packageJson.scripts?.['verify:locks'] === 'node tools/verify-npm-locks.mjs';
if (lockVerifierEnabled && !rootLockPresent) fail('N03 lock verification requires package-lock.json');
if (!lockVerifierEnabled && rootLockPresent) fail('root package-lock.json is forbidden until N03 lock verification is enabled');

const lifecycleHooks = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
for (const hook of lifecycleHooks) {
  if (Object.hasOwn(packageJson.scripts ?? {}, hook)) fail(`root lifecycle hook is not allowed: ${hook}`);
}

console.log(`ROOT_CONFIG_OK node=${expectedNode} npm=${expectedNpm} workspaces=${expectedWorkspaces.length}`);
