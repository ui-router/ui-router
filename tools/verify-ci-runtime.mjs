#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const contract = JSON.parse(
  readFileSync(path.join(repository, "migration/ci-gates.json"), "utf8")
);
function fail(message) {
  throw new Error(`CI_RUNTIME_FAILED: ${message}`);
}
function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.status !== 0) fail(`${executable} ${args.join(" ")} failed`);
  return result.stdout.trim();
}
function sha256File(filename) {
  return crypto
    .createHash("sha256")
    .update(readFileSync(filename))
    .digest("hex");
}
if (process.version !== `v${contract.runtime.node}`)
  fail(`Node ${contract.runtime.node} required, got ${process.version}`);
const npm = command("npm", ["--version"]);
if (npm !== contract.runtime.npm)
  fail(`npm ${contract.runtime.npm} required, got ${npm}`);
if (process.arch !== contract.runtime.architecture)
  fail(
    `architecture ${contract.runtime.architecture} required, got ${process.arch}`
  );

const github = process.env.GITHUB_ACTIONS === "true";
if (!github && process.env.CI_RUNTIME_ALLOW_HOST !== "1")
  fail("host verification requires CI_RUNTIME_ALLOW_HOST=1");
if (github && process.env.CI_RUNTIME_ALLOW_HOST)
  fail("CI may not bypass container verification");

if (github) {
  for (const [key, value] of Object.entries(contract.runtime.environment))
    if (process.env[key] !== value)
      fail(
        `${key} differs: expected ${value}, got ${
          process.env[key] ?? "<unset>"
        }`
      );
  if (process.env.CI_RUNTIME_IMAGE_DIGEST !== contract.runtime.ciImageDigest)
    fail("CI image digest environment differs from the rendered workflow");
  const osRelease = readFileSync("/etc/os-release", "utf8");
  if (
    !osRelease.includes('NAME="Ubuntu"') ||
    !osRelease.includes('VERSION_ID="24.04"')
  )
    fail("container OS is not Ubuntu 24.04");
  const executable = contract.runtime.environment.CHROME_BIN;
  if (!existsSync(executable))
    fail(`Chromium executable is missing: ${executable}`);
  if (sha256File(executable) !== contract.runtime.browser.executableSha256)
    fail("Chromium executable digest differs");
  const version = command(executable, ["--version"]);
  if (!version.includes(contract.runtime.browser.versionString))
    fail(`Chromium version differs: ${version}`);
}

console.log(
  JSON.stringify({
    status: "ok",
    mode: github ? "ci-container" : "approved-host",
    node: process.version.slice(1),
    npm,
    architecture: process.arch,
    imageDigest: github ? contract.runtime.ciImageDigest : null,
    browser: github
      ? {
          revision: contract.runtime.browser.revision,
          version: contract.runtime.browser.versionString,
          executableSha256: contract.runtime.browser.executableSha256,
        }
      : null,
  })
);
