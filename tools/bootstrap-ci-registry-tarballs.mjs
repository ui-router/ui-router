#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const turboVersion = "2.10.12";
const privateRegistry =
  "https://artifacts.netflix.net/api/npm/npm-netflix/_relative/";
const tarballs = [
  ["@turbo/darwin-64", "darwin-64"],
  ["@turbo/darwin-arm64", "darwin-arm64"],
  ["@turbo/linux-64", "linux-64"],
  ["@turbo/linux-arm64", "linux-arm64"],
  ["@turbo/windows-64", "windows-64"],
  ["@turbo/windows-arm64", "windows-arm64"],
  ["turbo", "turbo"],
];
function fail(message) {
  throw new Error(`CI_REGISTRY_BOOTSTRAP_FAILED: ${message}`);
}
const lock = JSON.parse(
  readFileSync(path.join(repository, "package-lock.json"), "utf8")
);
const urls = tarballs.map(([packageName, filename]) => {
  const entry = lock.packages[`node_modules/${packageName}`];
  if (!entry) fail(`lock is missing ${packageName}`);
  if (entry.version !== turboVersion)
    fail(`${packageName} version ${entry.version} is not ${turboVersion}`);
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-"))
    fail(`${packageName} has no sha512 integrity`);
  const expectedPrivate = `${privateRegistry}${packageName}/-/${filename}-${turboVersion}.tgz`;
  if (entry.resolved !== expectedPrivate)
    fail(`${packageName} source URL differs from the reviewed lock`);
  return `https://registry.npmjs.org/${packageName}/-/${filename}-${turboVersion}.tgz`;
});
const result = spawnSync(
  "npm",
  [
    "cache",
    "add",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...urls,
  ],
  { cwd: repository, stdio: "inherit" }
);
if (result.status !== 0)
  fail(`npm cache add exited ${result.status ?? result.signal}`);
console.log(`CI_REGISTRY_BOOTSTRAP_OK tarballs=${urls.length}`);
