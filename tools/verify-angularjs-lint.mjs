#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const repository = realpathSync(path.join(import.meta.dirname, ".."));
const workspace = "frameworks/angularjs/uirouter-angularjs";

function fail(message) {
  throw new Error(`ANGULARJS_LINT_FAILED: ${message}`);
}
function readJson(relative) {
  return JSON.parse(readFileSync(path.join(repository, relative), "utf8"));
}
function sha256(relative) {
  return crypto
    .createHash("sha256")
    .update(readFileSync(path.join(repository, relative)))
    .digest("hex");
}
function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--output" || !process.argv[index + 1])
    fail(`unknown argument ${process.argv[index]}`);
  index += 1;
}

const angularjsManifest = readJson(`${workspace}/package.json`);
const coreManifest = readJson("core/package.json");
const dependencyNames = [
  "eslint",
  "@typescript-eslint/parser",
  "@typescript-eslint/eslint-plugin",
];
const declared = Object.fromEntries(
  dependencyNames.map((name) => [
    name,
    angularjsManifest.devDependencies?.[name],
  ])
);
const expected = Object.fromEntries(
  dependencyNames.map((name) => [name, coreManifest.devDependencies?.[name]])
);
if (JSON.stringify(declared) !== JSON.stringify(expected))
  fail(
    `AngularJS lint declarations differ from the root-compatible core lane: ${JSON.stringify(
      declared
    )}`
  );

const packageLock = readJson("package-lock.json");
for (const stale of [
  `${workspace}/node_modules/eslint`,
  `${workspace}/node_modules/@typescript-eslint/parser`,
  `${workspace}/node_modules/@typescript-eslint/eslint-plugin`,
  "node_modules/@typescript-eslint/experimental-utils",
]) {
  if (packageLock.packages[stale])
    fail(`stale mixed-toolchain lock entry remains: ${stale}`);
}

const environment = { ...process.env };
delete environment.NODE_PATH;
for (const key of Object.keys(environment)) {
  if (key.toLowerCase().startsWith("npm_config_")) delete environment[key];
}
const lint = spawnSync(
  "npm",
  ["--workspace", "@uirouter/angularjs", "run", "lint"],
  {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }
);
if (lint.status !== 0)
  fail(`lint exited ${lint.status}: ${(lint.stderr || lint.stdout).trim()}`);

const resolved = Object.fromEntries(
  dependencyNames.map((name) => {
    const packageJson = readJson(`node_modules/${name}/package.json`);
    return [name, packageJson.version];
  })
);
const evidence = {
  schemaVersion: 1,
  status: "passed",
  workspace,
  command: ["npm", "--workspace", "@uirouter/angularjs", "run", "lint"],
  declared,
  resolved,
  packageManifestSha256: sha256(`${workspace}/package.json`),
  packageLockSha256: sha256("package-lock.json"),
};

const outputArgument = argument("--output");
if (outputArgument) {
  const output = path.resolve(repository, outputArgument);
  const allowed = path.join(repository, ".ci-results", "source");
  const relation = path.relative(allowed, output);
  if (relation.startsWith("..") || path.isAbsolute(relation))
    fail("output must remain under .ci-results/source");
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
  renameSync(temporary, output);
}

console.log(
  `ANGULARJS_LINT_OK eslint=${resolved.eslint} typescriptEslint=${resolved["@typescript-eslint/eslint-plugin"]}`
);
