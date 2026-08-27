#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
  repository,
} from "./integration-matrix-lib.mjs";

const cases = [];
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
