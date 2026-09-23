#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertExternalSandbox,
  assertNoLinksOrSharedFiles,
  integrationEvidenceScopePaths,
  repository,
} from "./integration-matrix-lib.mjs";

const cases = [];
const history = mkdtempSync(path.join(os.tmpdir(), "uirouter-i02-scope-"));
try {
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Integration test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd: history, encoding: "utf8" }).trim();
  git("init", "--quiet");
  writeFileSync(path.join(history, "source.js"), "original\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "original proof");
  const oldProof = git("rev-parse", "HEAD");
  writeFileSync(path.join(history, "source.js"), "reviewed change\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "reviewed checkpoint");
  const reviewed = git("rev-parse", "HEAD");
  assert.deepEqual(integrationEvidenceScopePaths(history, oldProof, reviewed), ["source.js"]);
  cases.push("older-proof-retains-reviewed-ownership-check");
  assert.deepEqual(integrationEvidenceScopePaths(history, reviewed, reviewed), []);
  cases.push("checkpoint-proof-has-no-unproved-changes");
  writeFileSync(path.join(history, "CHANGELOG.md"), "prepared release\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "fresh candidate proof");
  const freshProof = git("rev-parse", "HEAD");
  assert.deepEqual(integrationEvidenceScopePaths(history, freshProof, reviewed), []);
  cases.push("fresh-candidate-does-not-diff-backwards");
  git("checkout", "--quiet", "--detach", oldProof);
  writeFileSync(path.join(history, "branch.txt"), "other proof branch\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "divergent proof");
  assert.deepEqual(integrationEvidenceScopePaths(history, git("rev-parse", "HEAD"), reviewed), ["source.js"]);
  cases.push("divergent-proof-retains-reviewed-branch-changes");
} finally {
  rmSync(history, { recursive: true, force: true });
}
function rejects(name, operation) {
  try {
    operation();
    throw new Error(`mutation unexpectedly passed: ${name}`);
  } catch (error) {
    if (String(error.message).startsWith("mutation unexpectedly passed"))
      throw error;
    cases.push(name);
  }
}

const adapter = path.join(repository, "tools/i02-npx-local-bin.mjs");
const forbidden = spawnSync(process.execPath, [adapter, "playwright"], {
  encoding: "utf8",
});
if (forbidden.status !== 64)
  throw new Error("command adapter accepted a non-serve package");
cases.push("adapter-package-allowlist");

const retired = spawnSync(
  process.execPath,
  [
    path.join(repository, "tools/run-integration-matrix.mjs"),
    "--project",
    "framework/react-hybrid/integration/react16",
  ],
  { encoding: "utf8" }
);
if (
  retired.status === 0 ||
  !`${retired.stdout}\n${retired.stderr}`.includes(
    "is retired from active integration"
  )
)
  throw new Error("integration runner accepted the retired React 16 project");
cases.push("retired-project-rejected");

const fixture = mkdtempSync(
  path.join(os.tmpdir(), "uirouter-i02-runner-test-")
);
try {
  const source = path.join(fixture, "source");
  const copy = path.join(fixture, "copy");
  mkdirSync(source);
  mkdirSync(copy);
  writeFileSync(path.join(source, "file.txt"), "source\n");
  copyFileSync(path.join(source, "file.txt"), path.join(copy, "file.txt"));
  assertExternalSandbox(repository, fixture);
  assertNoLinksOrSharedFiles(source, copy);
  cases.push("independent-byte-copy");

  writeFileSync(path.join(copy, "file.txt"), "mutated\n");
  rejects("copied-source-content-mutation", () =>
    assertNoLinksOrSharedFiles(source, copy)
  );

  rmSync(path.join(copy, "file.txt"));
  linkSync(path.join(source, "file.txt"), path.join(copy, "file.txt"));
  rejects("mutable-hard-link", () => assertNoLinksOrSharedFiles(source, copy));

  rmSync(path.join(copy, "file.txt"));
  symlinkSync(path.join(source, "file.txt"), path.join(copy, "file.txt"));
  rejects("source-symlink", () => assertNoLinksOrSharedFiles(source, copy));
  rejects("repository-ancestor-sandbox", () =>
    assertExternalSandbox(repository, repository)
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(`INTEGRATION_RUNNER_ADVERSARIAL_OK cases=${cases.length}`);
