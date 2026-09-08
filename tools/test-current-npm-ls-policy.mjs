#!/usr/bin/env node

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  activePackageManifests,
  loadCurrentNpmLsPolicy,
} from "./current-npm-ls-policy.mjs";

const source = path.resolve(import.meta.dirname, "..");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "uirouter-p01-policy-"));
const controlFiles = [
  "migration/evidence/n03/root-npm-ls-problems.json",
  "migration/evidence/p01/npm-ls-resolutions.json",
];
let passed = 0;

function copy(relative, target) {
  mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
  copyFileSync(path.join(source, relative), path.join(target, relative));
}

function checkout(name) {
  const target = path.join(tempRoot, name);
  for (const relative of [
    ...controlFiles,
    ...activePackageManifests(source),
  ])
    copy(relative, target);
  return target;
}

function json(repository, relative) {
  return JSON.parse(readFileSync(path.join(repository, relative), "utf8"));
}

function save(repository, relative, value) {
  writeFileSync(
    path.join(repository, relative),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

function expectSuccess(name) {
  const result = loadCurrentNpmLsPolicy(checkout(name));
  if (result.currentProblemCount !== 14)
    throw new Error(`${name}: expected 14 current problems`);
  passed += 1;
}

function expectFailure(name, mutate, expected) {
  const repository = checkout(name);
  mutate(repository);
  try {
    loadCurrentNpmLsPolicy(repository);
  } catch (error) {
    if (expected.test(String(error))) {
      passed += 1;
      return;
    }
    throw new Error(`${name}: expected ${expected}, got ${error}`);
  }
  throw new Error(`${name}: policy unexpectedly passed`);
}

try {
  expectSuccess("baseline");
  expectFailure(
    "baseline-drift",
    (repository) => {
      const relative = controlFiles[0];
      const value = json(repository, relative);
      value.problems.push("invalid: invented@1.0.0 <root>/node_modules/invented");
      value.problemCount += 1;
      save(repository, relative, value);
    },
    /reviewed N03 baseline/
  );
  expectFailure(
    "unknown-problem",
    (repository) => {
      const relative = controlFiles[1];
      const value = json(repository, relative);
      value.resolved[0].problem =
        "invalid: vitest@0.0.0 <root>/node_modules/vitest";
      save(repository, relative, value);
    },
    /unknown problem/
  );
  expectFailure(
    "duplicate-problem",
    (repository) => {
      const relative = controlFiles[1];
      const value = json(repository, relative);
      value.resolved.push(structuredClone(value.resolved[0]));
      save(repository, relative, value);
    },
    /resolved more than once/
  );
  expectFailure(
    "manifest-range-drift",
    (repository) => {
      const relative = "plugins/dsr/package.json";
      const value = json(repository, relative);
      value.devDependencies.vitest = "^3.2.7";
      save(repository, relative, value);
    },
    /does not prove the vitest resolution/
  );
  expectFailure(
    "manifest-inventory-omission",
    (repository) => {
      const relative = controlFiles[1];
      const value = json(repository, relative);
      value.resolved[0].manifests.pop();
      save(repository, relative, value);
    },
    /manifest inventory differs/
  );
  expectFailure(
    "unsafe-manifest-path",
    (repository) => {
      const relative = controlFiles[1];
      const value = json(repository, relative);
      value.resolved[0].manifests[0] = "../outside/package.json";
      save(repository, relative, value);
    },
    /safe repository-relative path/
  );
  expectFailure(
    "current-count-drift",
    (repository) => {
      const relative = controlFiles[1];
      const value = json(repository, relative);
      value.currentProblemCount = 15;
      save(repository, relative, value);
    },
    /current problem count/
  );
  console.log(`CURRENT_NPM_LS_POLICY_TESTS_OK cases=${passed}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
