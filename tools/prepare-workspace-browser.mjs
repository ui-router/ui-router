#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const sourceRelative =
  "frameworks/angular/examples/sample-app/node_modules/@angular/build";
const destinationRelative =
  "plugins/sticky-states/examples/angular-cli/node_modules/@angular/build";
const source = path.join(repository, sourceRelative);
const destination = path.join(repository, destinationRelative);
const relativeTarget = path.relative(path.dirname(destination), source);
const output = path.join(
  repository,
  ".ci-results/browser/workspace-tool-link.json"
);
function fail(message) {
  throw new Error(`CI_WORKSPACE_BROWSER_PREPARE_FAILED: ${message}`);
}
if (
  process.argv.length > 3 ||
  (process.argv[2] && process.argv[2] !== "--cleanup")
)
  fail(`unknown argument ${process.argv[2]}`);
const lock = JSON.parse(
  readFileSync(path.join(repository, "package-lock.json"), "utf8")
);
const sourceLock = lock.packages[sourceRelative];
const destinationLock = lock.packages[destinationRelative];
if (
  !sourceLock ||
  !destinationLock ||
  sourceLock.version !== "22.1.5" ||
  destinationLock.version !== sourceLock.version ||
  destinationLock.integrity !== sourceLock.integrity
)
  fail("the @angular/build lock bindings differ");
const packageJson = JSON.parse(
  readFileSync(path.join(source, "package.json"), "utf8")
);
if (
  packageJson.name !== "@angular/build" ||
  packageJson.version !== sourceLock.version
)
  fail("the physical @angular/build source differs from its lock binding");

if (process.argv[2] === "--cleanup") {
  let status;
  try {
    status = lstatSync(destination);
  } catch (error) {
    if (error.code === "ENOENT") fail("workspace tool link is missing");
    throw error;
  }
  if (!status.isSymbolicLink() || readlinkSync(destination) !== relativeTarget)
    fail("workspace tool link differs before cleanup");
  rmSync(destination);
  console.log("CI_WORKSPACE_BROWSER_CLEANUP_OK links=1");
  process.exit(0);
}
try {
  lstatSync(destination);
  fail("workspace tool destination already exists");
} catch (error) {
  if (error.message.startsWith("CI_WORKSPACE_BROWSER_PREPARE_FAILED"))
    throw error;
  if (error.code !== "ENOENT") throw error;
}
mkdirSync(path.dirname(destination), { recursive: true });
symlinkSync(relativeTarget, destination, "dir");
const evidence = {
  schemaVersion: 1,
  status: "prepared",
  links: [
    {
      package: "@angular/build",
      version: sourceLock.version,
      integrity: sourceLock.integrity,
      source: sourceRelative,
      destination: destinationRelative,
      relativeTarget,
    },
  ],
};
mkdirSync(path.dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`);
renameSync(temporary, output);
console.log("CI_WORKSPACE_BROWSER_PREPARE_OK links=1");
