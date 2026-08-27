#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  canonicalJson,
  fixtureTreeSha256,
  matrixPath,
  repository,
  runLockSchemaPath,
  sha256,
  sha256File,
  validateIntegrationMatrix,
} from "./integration-matrix-lib.mjs";
import { validateJsonSchema } from "./validate-migration-contract.mjs";

function fail(message) {
  throw new Error(`INTEGRATION_RUN_VERIFY_FAILED: ${message}`);
}
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
const known = new Set(["--root", "--expect-failure"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!known.has(argument)) fail(`unknown argument ${argument}`);
  if (argument === "--root") index += 1;
}
const rootArgument = value("--root");
if (!rootArgument) fail("--root is required");
const evidenceRoot = realpathSync(path.resolve(rootArgument));
function directorySha256(directory) {
  const records = [];
  function walk(absolute, relative = "") {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const child = path.join(absolute, entry.name);
      const portable = path.posix.join(relative, entry.name);
      const info = lstatSync(child);
      if (info.isSymbolicLink())
        fail(`evidence directory contains symlink ${portable}`);
      if (info.isDirectory()) walk(child, portable);
      else if (info.isFile()) {
        const contents = readFileSync(child);
        records.push({
          path: portable,
          size: contents.length,
          sha256: sha256(contents),
        });
      } else fail(`evidence directory contains unsupported entry ${portable}`);
    }
  }
  walk(directory);
  return sha256(canonicalJson(records));
}
const expectFailure = process.argv.includes("--expect-failure");
const validated = await validateIntegrationMatrix();
const { matrix } = validated;
const summaryPath = path.join(evidenceRoot, "summary.json");
if (!existsSync(summaryPath)) fail("summary.json is missing");
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const matrixSha256 = sha256File(path.join(repository, matrixPath));
if (summary.schemaVersion !== 1 || summary.matrixSha256 !== matrixSha256)
  fail("summary identity or matrix digest differs");
if (new Set(summary.selected).size !== summary.selected.length)
  fail("summary repeats a selected project");
if (summary.results.length !== summary.counts.passed + summary.counts.failed)
  fail("summary result counts differ");
if (expectFailure ? summary.counts.failed !== 1 : summary.counts.failed !== 0)
  fail("summary failure count differs from expectation");

const projectById = new Map(
  matrix.projects.map((record) => [record.id, record])
);
for (const id of summary.selected) {
  const project = projectById.get(id);
  if (!project || project.mode !== "runnable")
    fail(`selected project is not runnable: ${id}`);
}
for (const result of summary.results) {
  const project = projectById.get(result.fixtureId);
  if (!project) fail(`unknown result fixture ${result.fixtureId}`);
  const runLockPath = path.join(evidenceRoot, result.runLock);
  if (!existsSync(runLockPath))
    fail(`${result.fixtureId}: run lock is missing`);
  const runLock = JSON.parse(readFileSync(runLockPath, "utf8"));
  try {
    await validateJsonSchema(runLock, path.join(repository, runLockSchemaPath));
  } catch (error) {
    fail(`${result.fixtureId}: run-lock schema: ${error.message}`);
  }
  if (
    runLock.fixtureId !== result.fixtureId ||
    runLock.mode !== summary.mode ||
    runLock.contracts.matrixSha256 !== matrixSha256 ||
    runLock.result.status !== result.status
  )
    fail(`${result.fixtureId}: run-lock identity differs`);
  if (result.status === "pass") {
    if (sha256(canonicalJson(runLock)) !== result.runLockSha256)
      fail(`${result.fixtureId}: run-lock digest differs`);
    if (runLock.result.waiver !== null || runLock.failureBundle !== null)
      fail(`${result.fixtureId}: passing run has waiver/failure bundle`);
    if (runLock.mode === "clean" && !runLock.replay.retainedSandbox) {
      if (existsSync(runLock.sandbox.path))
        fail(`${result.fixtureId}: successful clean sandbox was not removed`);
    }
  } else {
    if (!expectFailure || !runLock.failureBundle)
      fail(`${result.fixtureId}: failure bundle is missing`);
    if (!existsSync(runLock.sandbox.path))
      fail(`${result.fixtureId}: failed sandbox was not retained`);
    const bundle = runLock.failureBundle;
    if (bundle.contents.length !== matrix.failureBundleContents.length)
      fail(`${result.fixtureId}: failure bundle content count differs`);
    const names = bundle.contents.map((record) => record.name);
    if (canonicalJson(names) !== canonicalJson(matrix.failureBundleContents))
      fail(`${result.fixtureId}: failure bundle names differ`);
    for (const record of bundle.contents) {
      const absolute = path.join(bundle.path, record.path);
      if (!existsSync(absolute))
        fail(`${result.fixtureId}: failure bundle path missing ${record.name}`);
      const digest = statSync(absolute).isDirectory()
        ? directorySha256(absolute)
        : sha256File(absolute);
      if (digest !== record.sha256)
        fail(
          `${result.fixtureId}: failure bundle digest differs ${record.name}`
        );
    }
    if (sha256(canonicalJson(bundle.contents)) !== bundle.sha256)
      fail(`${result.fixtureId}: failure bundle manifest digest differs`);
  }

  if (Object.hasOwn(runLock.environment, "NODE_PATH"))
    fail(`${result.fixtureId}: run lock retained NODE_PATH`);
  if (
    runLock.sentinel.package !== matrix.sandboxPolicy.sentinelPackage ||
    runLock.sentinel.preexisting !== false ||
    runLock.sentinel.resolved !== false
  )
    fail(`${result.fixtureId}: sentinel probe differs`);
  if (
    runLock.original.manifestSha256 !== project.committedManifestSha256 ||
    runLock.original.lockSha256 !== project.committedLock.sha256 ||
    fixtureTreeSha256(repository, project.manifest) !==
      project.fixtureTreeSha256
  )
    fail(`${result.fixtureId}: original fixture binding differs`);
  const originIds = runLock.origins.map((record) => record.edgeId).sort();
  if (canonicalJson(originIds) !== canonicalJson([...project.edgeIds].sort()))
    fail(`${result.fixtureId}: logical origin coverage differs`);
  if (result.status === "pass") {
    if (runLock.origins.some((record) => record.status !== "verified"))
      fail(`${result.fixtureId}: passing run has unavailable origin evidence`);
    if (
      runLock.dependencyGraphs.externalBeforeSha256 !==
        project.externalGraph.sha256 ||
      runLock.dependencyGraphs.externalAfterSha256 !==
        project.expectedExternalGraphSha256
    )
      fail(`${result.fixtureId}: external graph evidence differs`);
  }
  const expectedArtifacts = [
    ...new Set(project.rewrites.map((record) => record.artifactId)),
  ].sort();
  const actualArtifacts = runLock.artifacts
    .map((record) => record.artifactId)
    .sort();
  if (canonicalJson(actualArtifacts) !== canonicalJson(expectedArtifacts))
    fail(`${result.fixtureId}: artifact coverage differs`);
  for (const artifact of runLock.artifacts) {
    const absolute = path.join(evidenceRoot, artifact.path);
    if (!existsSync(absolute) || sha256File(absolute) !== artifact.sha256)
      fail(
        `${result.fixtureId}: evidence artifact differs ${artifact.artifactId}`
      );
  }
}

console.log(
  `INTEGRATION_RUN_EVIDENCE_OK mode=${summary.mode} passed=${summary.counts.passed} failed=${summary.counts.failed} selected=${summary.counts.selected}`
);
