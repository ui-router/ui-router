#!/usr/bin/env node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  assertIdenticalFingerprints,
  cleanReproducibilityFingerprint,
  contractPath,
  repository,
  validateCleanReproducibility,
} from "./clean-reproducibility-lib.mjs";
import { canonicalJson, sha256, sha256File } from "./ci-gates-lib.mjs";

function fail(message) {
  throw new Error(`CLEAN_REPRODUCIBILITY_PROVE_FAILED: ${message}`);
}
function command(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    cwd: options.cwd ?? repository,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error)
    fail(`${executable} ${argv.join(" ")} failed to start: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${executable} ${argv.join(" ")} exited ${result.status ?? result.signal}`);
  return result.stdout.trim();
}
function git(root, argv, options = {}) {
  return command("git", ["-c", "core.fsmonitor=false", ...argv], {
    ...options,
    cwd: root,
  });
}
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--output" || !process.argv[index + 1])
    fail(`unknown argument ${process.argv[index]}`);
  index += 1;
}

function assertClean(workspace, label) {
  for (const args of [
    ["diff", "--quiet"],
    ["diff", "--cached", "--quiet"],
    ["diff", "--quiet", "--", "package-lock.json"],
    ["diff", "--cached", "--quiet", "--", "package-lock.json"],
  ]) {
    const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (result.status !== 0) fail(`${label} changed tracked source or lockfile`);
  }
  const status = git(workspace, ["status", "--porcelain", "--untracked-files=no"]);
  if (status) fail(`${label} changed tracked source or lockfile: ${status}`);
}
function createArchiveWorkspace(root, temporary, id, revision) {
  const archive = path.join(temporary, `run-${id}.tar`);
  const workspace = path.join(temporary, `run-${id}`);
  git(root, ["archive", "--format=tar", "HEAD", "-o", archive]);
  const archiveSha256 = sha256File(archive);
  mkdirSync(workspace);
  command("tar", ["-xf", archive, "-C", workspace]);
  git(workspace, ["init", "--quiet", "--initial-branch=c02-archive"]);
  git(workspace, ["config", "user.name", "C02 clean reproducibility"]);
  git(workspace, ["config", "user.email", "c02@ui-router.invalid"]);
  // git archive includes tracked paths which are ignored for generated outputs;
  // force-add the pristine archive so its disposable index represents HEAD exactly.
  git(workspace, ["add", "--all", "--force"]);
  git(
    workspace,
    ["commit", "--quiet", "--no-gpg-sign", "-m", "C02 archive snapshot"],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    }
  );
  if (git(workspace, ["rev-parse", "HEAD^{tree}"]) !== git(root, ["rev-parse", "HEAD^{tree}"]))
    fail(`archive workspace ${id} source tree differs from ${revision}`);
  assertClean(workspace, `archive workspace ${id} before commands`);
  return { archiveSha256, workspace };
}
function runArchiveWorkspace({
  id,
  root,
  temporary,
  revision,
  tree,
  contract,
  ci,
  packageArtifacts,
}) {
  const { archiveSha256, workspace } = createArchiveWorkspace(
    root,
    temporary,
    id,
    revision
  );
  const completed = [];
  let browserPrepared = false;
  let browserCleaned = false;
  try {
    for (const commandRecord of contract.commands) {
      if (commandRecord.id === "cleanup-browser") continue;
      const [executable, ...argv] = commandRecord.argv;
      command(executable, argv, {
        cwd: workspace,
        env: { ...process.env, GITHUB_SHA: revision },
      });
      completed.push(commandRecord.id);
      if (commandRecord.id === "prepare-browser") browserPrepared = true;
      assertClean(workspace, `archive workspace ${id} after ${commandRecord.id}`);
    }
    const cleanup = contract.commands.at(-1);
    command(cleanup.argv[0], cleanup.argv.slice(1), {
      cwd: workspace,
      env: { ...process.env, GITHUB_SHA: revision },
    });
    completed.push(cleanup.id);
    browserCleaned = true;
    assertClean(workspace, `archive workspace ${id} after ${cleanup.id}`);

    const packageManifest = JSON.parse(
      readFileSync(path.join(workspace, ".ci-artifacts/packages/hashes.json"), "utf8")
    );
    const docsWaivers = JSON.parse(
      readFileSync(path.join(workspace, ".ci-results/docs/waivers.json"), "utf8")
    );
    const fingerprint = cleanReproducibilityFingerprint({
      revision,
      tree,
      archiveSha256,
      contract,
      packageManifest,
      packageArtifacts,
      docsWaivers,
      ci,
    });
    return {
      id,
      commands: completed,
      fingerprint,
      fingerprintSha256: sha256(canonicalJson(fingerprint)),
    };
  } finally {
    if (browserPrepared && !browserCleaned) {
      const cleanup = contract.commands.at(-1);
      try {
        command(cleanup.argv[0], cleanup.argv.slice(1), {
          cwd: workspace,
          env: { ...process.env, GITHUB_SHA: revision },
        });
      } catch (error) {
        process.stderr.write(`C02 cleanup failure: ${error.message}\n`);
      }
    }
  }
}

const { contract, ci, packageArtifacts, root } = await validateCleanReproducibility();
const outputArgument = value("--output") ?? contract.proof.output;
if (outputArgument !== contract.proof.output)
  fail(`--output must be ${contract.proof.output}`);
const output = path.join(root, outputArgument);
const runtimeText = command("node", ["tools/verify-ci-runtime.mjs"], { cwd: root });
let runtime;
try {
  runtime = JSON.parse(runtimeText);
} catch {
  fail("C01 runtime verifier did not produce JSON");
}
assertClean(root, "primary checkout before archive runs");
const revision = git(root, ["rev-parse", "HEAD"]);
const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
const temporary = mkdtempSync(path.join(os.tmpdir(), "uirouter-c02-reproducibility-"));
try {
  const runs = [];
  for (let id = 1; id <= contract.proof.runs; id += 1)
    runs.push(
      runArchiveWorkspace({
        id,
        root,
        temporary,
        revision,
        tree,
        contract,
        ci,
        packageArtifacts,
      })
    );
  assertIdenticalFingerprints(runs[0].fingerprint, runs[1].fingerprint);
  const proof = {
    schemaVersion: 1,
    task: "C02",
    owner: contract.owner,
    contractSha256: sha256File(path.join(root, contractPath)),
    repository: {
      revision,
      tree,
      c01Head: contract.c01.head,
      c01Tree: contract.c01.tree,
    },
    runtime,
    runs,
    comparison: {
      status: "identical",
      fingerprintSha256: runs[0].fingerprintSha256,
    },
  };
  mkdirSync(path.dirname(output), { recursive: true });
  const temporaryOutput = `${output}.tmp-${process.pid}`;
  writeFileSync(temporaryOutput, `${JSON.stringify(proof, null, 2)}\n`);
  renameSync(temporaryOutput, output);
  console.log(
    `CLEAN_REPRODUCIBILITY_PROOF_OK runs=${runs.length} fingerprint=${proof.comparison.fingerprintSha256}`
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
