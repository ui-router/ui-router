#!/usr/bin/env node
'use strict';

const findParentDir = require('find-parent-dir');
const fs = require('fs');
const path = require('path');
require('shelljs/global');

function packageDir() {
  const packageDir = findParentDir.sync(process.cwd(), 'package.json');
  cd(packageDir);
}

/**
 * Enforces npm as the only package manager for current monorepo tooling.
 * @param {string} [dir] - Directory to check (defaults to cwd)
 * @returns {'npm'}
 */
function detectPackageManager(dir) {
  dir = dir || process.cwd();
  const forbiddenLocks = ['yarn.lock', 'pnpm-lock.yaml'].filter((name) => fs.existsSync(path.join(dir, name)));
  if (forbiddenLocks.length) {
    throw new Error(`Unsupported package-manager lockfile(s): ${forbiddenLocks.join(', ')}`);
  }
  return 'npm';
}

/**
 * Returns npm commands whose dependency mutations suppress lifecycle scripts.
 * @param {'npm'} [packageManager]
 * @returns {object}
 */
function getPackageManagerCommands(packageManager) {
  packageManager = packageManager || detectPackageManager();
  if (packageManager !== 'npm') throw new Error(`Unsupported package manager: ${packageManager}`);
  const safeFlags = '--ignore-scripts --no-audit --no-fund';
  return {
    install: (flags) => `npm install --prefer-dedupe ${safeFlags}${flags ? ' ' + flags : ''}`,
    run: (script) => `npm run ${script}`,
    test: () => 'npm test',
    add: (pkg, flags) => `npm install ${safeFlags} ${pkg}${flags ? ' ' + flags : ''}`,
    addDev: (pkg) => `npm install ${safeFlags} --save-dev ${pkg}`,
    upgrade: (packages, flags) =>
      `npm update ${safeFlags}${packages ? ' ' + (Array.isArray(packages) ? packages.join(' ') : packages) : ''}${flags ? ' ' + flags : ''}`,
    exec: (command) => `npm exec -- ${command}`,
    lockfileName: 'package-lock.json',
  };
}

function pm(dir) {
  return detectPackageManager(dir);
}

function pkgMgrCommands(dir) {
  return getPackageManagerCommands(detectPackageManager(dir));
}

function ensureCleanMaster(branch) {
  branch = branch || 'master';
  if (exec('git symbolic-ref HEAD').stdout.trim() !== `refs/heads/${branch}`)
    throw new Error(`Not on ${branch} branch, aborting`);
  if (exec('git status --porcelain').stdout.trim() !== '') throw new Error('Working copy is dirty, aborting');
}

function _exec(command, silent) {
  if (!silent) {
    echo(command);
    echo();
  }
  var result = exec(command, { silent: !!silent });
  if (result.code === 0) return result;
  echo(`cwd: ${process.cwd()}`);
  echo(`Aborting; non-zero return value (${result.code}) from: ${command}`);
  console.error(result.stderr);
  exit(result.code);
}

function _execInteractive(command) {
  echo(command);
  echo();
  const { spawnSync } = require('child_process');
  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    cwd: process.cwd(),
  });
  if (result.status === 0) return result;
  echo(`cwd: ${process.cwd()}`);
  echo(`Aborting; non-zero return value (${result.status}) from: ${command}`);
  exit(result.status);
}

function asJson(obj) {
  return JSON.stringify(obj, null, 2);
}

let ensure = (type) => (path) => {
  let is = false;
  try {
    is = fs.lstatSync(path)['is' + type]();
  } catch (e) {
    console.log(e);
  }
  if (!is) echo(`Not a ${type}: ${path}`) && exit(-3);
};
let assertDir = ensure('Directory');
let assertFile = ensure('File');

module.exports = {
  ensureCleanMaster: ensureCleanMaster,
  _exec: _exec,
  _execInteractive: _execInteractive,
  asJson: asJson,
  assertDir: assertDir,
  assertFile: assertFile,
  packageDir: packageDir,
  detectPackageManager: detectPackageManager,
  getPackageManagerCommands: getPackageManagerCommands,
  pm: pm,
  pkgMgrCommands: pkgMgrCommands,
};
