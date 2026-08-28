#!/usr/bin/env node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  assertIdenticalFingerprints,
  contractPath,
  repository,
  validateCleanReproducibility,
  workflowPath,
} from "./clean-reproducibility-lib.mjs";

const original = JSON.parse(readFileSync(path.join(repository, contractPath), "utf8"));
const originalWorkflow = readFileSync(path.join(repository, workflowPath), "utf8");
const temporary = mkdtempSync(path.join(os.tmpdir(), "uirouter-c02-adversarial-"));
let cases = 0;
function clone() {
  return structuredClone(original);
}
async function rejectContract(name, mutate) {
  const candidate = clone();
  mutate(candidate);
  const filename = path.join(temporary, `${String(cases).padStart(3, "0")}-${name}.json`);
  writeFileSync(filename, `${JSON.stringify(candidate, null, 2)}\n`);
  let rejected = false;
  try {
    await validateCleanReproducibility({ contract: filename });
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error(`CLEAN_REPRODUCIBILITY_TEST_FAILED: accepted ${name}`);
  cases += 1;
}
function rejectWorkflow(name, mutate) {
  const filename = path.join(temporary, `${String(cases).padStart(3, "0")}-${name}.yml`);
  writeFileSync(filename, mutate(originalWorkflow));
  const result = spawnSync(
    process.execPath,
    [path.join(repository, "tools/verify-clean-reproducibility.mjs"), "--workflow", filename],
    { cwd: repository, encoding: "utf8" }
  );
  if (result.status === 0)
    throw new Error(`CLEAN_REPRODUCIBILITY_TEST_FAILED: accepted workflow ${name}`);
  cases += 1;
}
function run(executable, argv, cwd, env) {
  const result = spawnSync(executable, argv, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `CLEAN_REPRODUCIBILITY_TEST_FAILED: ${executable} ${argv.join(" ")} failed: ${result.stderr}`
    );
  return result.stdout.trim();
}
function git(root, argv, env) {
  return run("git", ["-c", "core.fsmonitor=false", ...argv], root, env);
}
try {
  await validateCleanReproducibility();
  for (const field of Object.keys(original.bindings))
    await rejectContract(`binding-${field}`, (candidate) => {
      candidate.bindings[field] = "0".repeat(64);
    });
  await rejectContract("schema-version", (candidate) => {
    candidate.schemaVersion = 2;
  });
  await rejectContract("c01-tree", (candidate) => {
    candidate.c01.tree = "0".repeat(40);
  });
  await rejectContract("c01-head", (candidate) => {
    candidate.c01.head = "0".repeat(40);
  });
  await rejectContract("runtime-image", (candidate) => {
    candidate.runtime.ciImage = "mcr.microsoft.com/playwright:latest";
  });
  await rejectContract("runtime-node", (candidate) => {
    candidate.runtime.node = "24.18.0";
  });
  await rejectContract("runtime-environment", (candidate) => {
    candidate.runtime.environment.CHROME_BIN = "/tmp/chrome";
  });
  await rejectContract("action-pin", (candidate) => {
    candidate.actions.checkout.sha = "0".repeat(40);
  });
  await rejectContract("run-count", (candidate) => {
    candidate.proof.runs = 1;
  });
  await rejectContract("archive-snapshot", (candidate) => {
    candidate.proof.sourceSnapshot = "working-tree";
  });
  await rejectContract("install-policy", (candidate) => {
    candidate.commands[0].argv = ["npm", "install"];
  });
  await rejectContract("test-omission", (candidate) => {
    candidate.commands.splice(4, 1);
  });
  await rejectContract("pack-substitution", (candidate) => {
    candidate.commands[5].argv = ["npm", "run", "pack"];
  });
  await rejectContract("browser-cleanup", (candidate) => {
    candidate.commands.at(-1).argv = ["true"];
  });
  await rejectContract("workflow-timeout", (candidate) => {
    candidate.workflow.timeoutMinutes = 90;
  });

  rejectWorkflow("mutable-action", (text) =>
    text.replace(original.actions.checkout.sha, "actions/checkout@v4")
  );
  rejectWorkflow("mutable-image", (text) =>
    text.replace(original.runtime.ciImage, "mcr.microsoft.com/playwright:latest")
  );
  rejectWorkflow("shallow-checkout", (text) =>
    text.replace("          fetch-depth: 0", "          fetch-depth: 1")
  );
  rejectWorkflow("untrusted-checkout", (text) =>
    text.replace(
      'run: git config --global --add safe.directory "$GITHUB_WORKSPACE"',
      "run: true"
    )
  );
  rejectWorkflow("cache-action", (text) =>
    text.replace(
      "      - name: Verify C02 contract and generated workflow\n",
      "      - uses: actions/cache@v4\n      - name: Verify C02 contract and generated workflow\n"
    )
  );
  rejectWorkflow("archive-proof", (text) =>
    text.replace("Run two clean archive workspaces", "Run one working tree")
  );
  rejectWorkflow("proof-verification", (text) =>
    text.replace("      - name: Verify reproducibility proof\n", "      - name: Omit proof verification\n")
  );
  let rejectedMismatch = false;
  try {
    assertIdenticalFingerprints({ value: 1 }, { value: 2 });
  } catch {
    rejectedMismatch = true;
  }
  if (!rejectedMismatch)
    throw new Error("CLEAN_REPRODUCIBILITY_TEST_FAILED: accepted mismatched fingerprints");
  cases += 1;
  const archiveRoot = path.join(temporary, "archive-workspace");
  const archive = path.join(temporary, "source.tar");
  git(repository, ["archive", "--format=tar", "HEAD", "-o", archive]);
  mkdirSync(archiveRoot);
  run("tar", ["-xf", archive, "-C", archiveRoot], repository);
  git(archiveRoot, ["init", "--quiet", "--initial-branch=c02-archive"]);
  git(archiveRoot, ["config", "user.name", "C02 clean reproducibility"]);
  git(archiveRoot, ["config", "user.email", "c02@ui-router.invalid"]);
  git(archiveRoot, ["add", "--all", "--force"]);
  git(
    archiveRoot,
    ["commit", "--quiet", "--no-gpg-sign", "-m", "C02 archive snapshot"],
    {
      ...process.env,
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    }
  );
  if (
    git(archiveRoot, ["rev-parse", "HEAD^{tree}"]) !==
    git(repository, ["rev-parse", "HEAD^{tree}"])
  )
    throw new Error(
      "CLEAN_REPRODUCIBILITY_TEST_FAILED: git archive snapshot does not preserve HEAD"
    );
  cases += 1;
  console.log(`CLEAN_REPRODUCIBILITY_ADVERSARIAL_OK cases=${cases}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
