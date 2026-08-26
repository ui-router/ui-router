#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taskCommit = "dde428f978e0d2dd578c77573971a7a5c1424300";
const mode = process.argv[2];
const immutablePaths = [
  "migration/evidence/i01/install-proof.json",
  "migration/evidence/i01/isolation-proof.json",
  "migration/isolated-projects.json",
  "migration/schemas/isolated-projects.schema.json",
  "tools/i01-scope-lib.mjs",
  "tools/test-isolated-projects.mjs",
  "tools/verify-isolated-projects.mjs",
];

function fail(message) {
  throw new Error(`I01_IMMUTABLE_GATE_FAILED: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: options.encoding || "utf8",
    env: options.env || process.env,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status})\n${
        result.stdout || ""
      }${result.stderr || ""}`
    );
  }
  return result.stdout;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function verifyImmutableFiles() {
  for (const filename of immutablePaths) {
    const current = await readFile(path.join(root, filename));
    const committed = run("git", ["show", `${taskCommit}:${filename}`], {
      encoding: "buffer",
    });
    if (sha256(current) !== sha256(committed)) {
      fail(`${filename} differs from immutable I01 task commit ${taskCommit}`);
    }
  }
}

async function verifyCurrentTree() {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "uirouter-i01-current-")
  );
  const archive = path.join(fixture, "current.tar");
  try {
    run("git", ["archive", "--format=tar", "--output", archive, "HEAD"]);
    run("tar", ["--extract", "--file", archive, "--directory", fixture]);
    await unlink(archive);
    const historicalLock = run(
      "git",
      ["show", `${taskCommit}:package-lock.json`],
      {
        encoding: "buffer",
      }
    );
    await writeFile(path.join(fixture, "package-lock.json"), historicalLock);
    const output = run(
      "node",
      [
        path.join(fixture, "tools/verify-isolated-projects.mjs"),
        "--root",
        fixture,
        "--test-fixture-no-git",
      ],
      { env: { ...process.env, I01_TEST_FIXTURE: "1" } }
    );
    process.stdout.write(output);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function runImmutableTests() {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "uirouter-i01-tests-"));
  await rm(worktree, { recursive: true, force: true });
  try {
    run("git", ["worktree", "add", "--detach", worktree, taskCommit]);
    const output = run(
      "node",
      [path.join(worktree, "tools/test-isolated-projects.mjs")],
      {
        cwd: worktree,
      }
    );
    process.stdout.write(output);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
      encoding: "utf8",
    });
    await rm(worktree, { recursive: true, force: true });
  }
}

try {
  if (!["verify", "test"].includes(mode))
    fail("usage: node tools/run-immutable-i01-gate.mjs <verify|test>");
  await verifyImmutableFiles();
  if (mode === "verify") await verifyCurrentTree();
  else await runImmutableTests();
  console.log(`I01_IMMUTABLE_GATE_OK mode=${mode} taskCommit=${taskCommit}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
