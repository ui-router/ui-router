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
  assertExternalSandbox,
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
function safeRelative(root, relative, label) {
  if (path.isAbsolute(relative)) fail(`${label} must be relative`);
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (relation.startsWith("..") || path.isAbsolute(relation))
    fail(`${label} escapes its evidence root`);
  return resolved;
}
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
if (
  summary.results.length !==
  summary.counts.passed + summary.counts.waived + summary.counts.failed
)
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
  const runLockPath = safeRelative(
    evidenceRoot,
    result.runLock,
    `${result.fixtureId} run-lock path`
  );
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
  if (sha256(canonicalJson(runLock)) !== result.runLockSha256)
    fail(`${result.fixtureId}: run-lock digest differs`);
  if (runLock.bundleState !== "final")
    fail(`${result.fixtureId}: result does not reference a final run lock`);
  if (result.status === "pass") {
    if (runLock.result.waiver !== null || runLock.failureBundle !== null)
      fail(`${result.fixtureId}: passing run has waiver/failure bundle`);
    if (runLock.mode === "clean" && !runLock.replay.retainedSandbox) {
      if (existsSync(runLock.sandbox.path))
        fail(`${result.fixtureId}: successful clean sandbox was not removed`);
    }
  } else {
    if (!runLock.failureBundle)
      fail(`${result.fixtureId}: failure bundle is missing`);
    if (result.status === "failure" && !expectFailure)
      fail(`${result.fixtureId}: unexpected unwaived failure`);
    if (result.status === "waived-failure") {
      if (
        project.expectedResult !== "waived-failure" ||
        canonicalJson(runLock.result.waiver) !==
          canonicalJson(project.waiver) ||
        !project.expectedFailure.contains.every((text) =>
          runLock.result.failureReason.includes(text)
        )
      )
        fail(`${result.fixtureId}: waived failure policy differs`);
    }
    if (!existsSync(runLock.sandbox.path))
      fail(`${result.fixtureId}: failed sandbox was not retained`);
    assertExternalSandbox(repository, runLock.sandbox.path);
    if (lstatSync(runLock.sandbox.path).isSymbolicLink())
      fail(`${result.fixtureId}: failed sandbox is a symbolic link`);
    const bundle = runLock.failureBundle;
    if (!path.isAbsolute(bundle.path))
      fail(`${result.fixtureId}: failure bundle path must be absolute`);
    const bundleRoot = realpathSync(bundle.path);
    const bundleRelation = path.relative(evidenceRoot, bundleRoot);
    if (bundleRelation.startsWith("..") || path.isAbsolute(bundleRelation))
      fail(`${result.fixtureId}: failure bundle escapes evidence root`);
    if (bundle.contents.length !== matrix.failureBundleContents.length)
      fail(`${result.fixtureId}: failure bundle content count differs`);
    const names = bundle.contents.map((record) => record.name);
    if (canonicalJson(names) !== canonicalJson(matrix.failureBundleContents))
      fail(`${result.fixtureId}: failure bundle names differ`);
    for (const record of bundle.contents) {
      const absolute = safeRelative(
        bundleRoot,
        record.path,
        `${result.fixtureId} failure component ${record.name}`
      );
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
    const requiredProduced = new Set([
      "original-manifest",
      "original-lock-or-absence",
      "matrix-entry",
      "run-lock",
      "artifact-archives",
      "artifact-hash-manifest",
      "toolchain-config",
      "dependency-graph",
      "origin-audit",
      "ancestry-link-scan",
      "sentinel-probe",
      "exact-command",
      "replay-reset-commands",
    ]);
    for (const record of bundle.contents) {
      if (requiredProduced.has(record.name) && record.status !== "produced")
        fail(
          `${result.fixtureId}: required bundle component unavailable ${record.name}`
        );
      if (record.status === "produced" && record.reason !== null)
        fail(`${result.fixtureId}: produced bundle component has a reason`);
      if (record.status === "unavailable" && !record.reason)
        fail(
          `${result.fixtureId}: unavailable bundle component lacks a reason`
        );
    }
    const bundledRunLockRecord = bundle.contents.find(
      (record) => record.name === "run-lock"
    );
    const bundledRunLock = JSON.parse(
      readFileSync(
        safeRelative(bundleRoot, bundledRunLockRecord.path, "bundled run lock"),
        "utf8"
      )
    );
    try {
      await validateJsonSchema(
        bundledRunLock,
        path.join(repository, runLockSchemaPath)
      );
    } catch (error) {
      fail(`${result.fixtureId}: bundled run-lock schema: ${error.message}`);
    }
    if (
      bundledRunLock.bundleState !== "detached-pre-manifest" ||
      bundledRunLock.failureBundle !== null
    )
      fail(
        `${result.fixtureId}: bundled run lock is not an explicit detached lock`
      );
    const expectedDetached = {
      ...runLock,
      bundleState: "detached-pre-manifest",
      failureBundle: null,
    };
    if (canonicalJson(bundledRunLock) !== canonicalJson(expectedDetached))
      fail(
        `${result.fixtureId}: detached run lock differs from final failure lock`
      );
    const component = (name) =>
      bundle.contents.find((record) => record.name === name);
    const componentPath = (name) =>
      safeRelative(
        bundleRoot,
        component(name).path,
        `${result.fixtureId} ${name}`
      );
    const lastStep = runLock.steps.at(-1);
    const exactCommand = JSON.parse(
      readFileSync(componentPath("exact-command"), "utf8")
    );
    if (canonicalJson(exactCommand) !== canonicalJson(lastStep.argv))
      fail(`${result.fixtureId}: bundled command differs from the last step`);
    for (const [name, expectedDigest] of [
      ["stdout", lastStep.stdoutSha256],
      ["stderr", lastStep.stderrSha256],
    ]) {
      const record = component(name);
      if (record.status === "produced" && record.sha256 !== expectedDigest)
        fail(`${result.fixtureId}: bundled ${name} differs from the last step`);
    }
    const artifactManifest = JSON.parse(
      readFileSync(componentPath("artifact-hash-manifest"), "utf8")
    );
    const archiveRoot = componentPath("artifact-archives");
    for (const artifact of artifactManifest) {
      const archive = safeRelative(
        archiveRoot,
        artifact.filename,
        `${result.fixtureId} artifact archive`
      );
      if (!existsSync(archive) || sha256File(archive) !== artifact.sha256)
        fail(
          `${result.fixtureId}: bundled artifact differs ${artifact.artifactId}`
        );
    }
    for (const [name, expected] of [
      ["dependency-graph", runLock.dependencyGraphs],
      ["origin-audit", runLock.origins],
      ["sentinel-probe", runLock.sentinel],
    ]) {
      const actual = JSON.parse(readFileSync(componentPath(name), "utf8"));
      if (canonicalJson(actual) !== canonicalJson(expected))
        fail(
          `${result.fixtureId}: bundled ${name} differs from final run lock`
        );
    }
  }

  if (Object.hasOwn(runLock.environment, "NODE_PATH"))
    fail(`${result.fixtureId}: run lock retained NODE_PATH`);
  const allowedEnvironment = new Set([
    "PATH",
    "HOME",
    "TMPDIR",
    ...Object.keys(matrix.runtime.environment),
    "npm_config_cache",
    "npm_config_registry",
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "npm_config_ignore_scripts",
    "npm_config_audit",
    "npm_config_fund",
    "npm_config_legacy_peer_deps",
    "npm_config_force",
    "npm_config_offline",
    "npm_config_bin_links",
    "PLAYWRIGHT_BROWSERS_PATH",
    "I02_COMMAND_ADAPTER_PATH",
  ]);
  for (const key of Object.keys(runLock.environment))
    if (!allowedEnvironment.has(key))
      fail(`${result.fixtureId}: unapproved effective environment key ${key}`);
  for (const key of [
    "npm_config_legacy_peer_deps",
    "npm_config_force",
    "npm_config_offline",
  ])
    if (runLock.environment[key] !== "false")
      fail(`${result.fixtureId}: unsafe npm configuration ${key}`);
  if (
    runLock.environment.npm_config_registry !== matrix.networkPolicy.registry ||
    runLock.environment.npm_config_ignore_scripts !== "true"
  )
    fail(`${result.fixtureId}: effective npm policy differs`);
  if (
    sha256File(runLock.toolchain.nodeExecutable) !==
      runLock.toolchain.nodeExecutableSha256 ||
    sha256File(runLock.toolchain.npmExecutable) !==
      runLock.toolchain.npmExecutableSha256
  )
    fail(`${result.fixtureId}: executable provenance differs`);
  if (
    runLock.sentinel.package !== matrix.sandboxPolicy.sentinelPackage ||
    runLock.sentinel.preexisting !== false ||
    runLock.sentinel.resolved !== false
  )
    fail(`${result.fixtureId}: sentinel probe differs`);
  if (project.browser && result.status === "pass") {
    if (
      !runLock.browser ||
      runLock.browser.installerIntegrity !==
        matrix.browser.installerIntegrity ||
      runLock.browser.launcherIntegrity !== matrix.browser.launcherIntegrity ||
      runLock.browser.coreIntegrity !== matrix.browser.coreIntegrity ||
      runLock.browser.descriptorSha256 !== matrix.browser.browsersJsonSha256 ||
      !runLock.browser.executableFiles.length
    )
      fail(`${result.fixtureId}: browser provenance differs`);
  } else if (!project.browser && runLock.browser !== null)
    fail(`${result.fixtureId}: non-browser fixture has browser evidence`);
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
    if (project.expectedResult !== "pass")
      fail(`${result.fixtureId}: project expected a waived failure`);
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
    ...new Set([
      ...project.rewrites.map((record) => record.artifactId),
      ...project.closureBindings.map((record) => record.artifactId),
    ]),
  ].sort();
  const actualArtifacts = runLock.artifacts
    .map((record) => record.artifactId)
    .sort();
  if (canonicalJson(actualArtifacts) !== canonicalJson(expectedArtifacts))
    fail(`${result.fixtureId}: artifact coverage differs`);
  if (
    canonicalJson([...runLock.staged.closureBindingIds].sort()) !==
    canonicalJson(project.closureBindings.map((record) => record.id).sort())
  )
    fail(`${result.fixtureId}: closure binding coverage differs`);
  const artifactById = new Map(
    runLock.artifacts.map((artifact) => [artifact.artifactId, artifact])
  );
  const internalLockPaths = new Set();
  for (const record of runLock.internalPackages) {
    if (internalLockPaths.has(record.lockPath))
      fail(
        `${result.fixtureId}: duplicate internal lock path ${record.lockPath}`
      );
    internalLockPaths.add(record.lockPath);
    const artifact = artifactById.get(record.artifactId);
    if (
      !artifact ||
      record.expectedVersion !== artifact.version ||
      record.lockIntegrity !== artifact.integrity ||
      !record.lockResolved.endsWith(artifact.filename) ||
      /^https?:/i.test(record.lockResolved) ||
      !record.insideSandbox ||
      record.symlink
    )
      fail(
        `${result.fixtureId}: internal package provenance differs ${record.lockPath}`
      );
  }
  if (result.status === "pass") {
    const topLevelIds = runLock.internalPackages
      .filter((record) => record.lockPath === `node_modules/${record.package}`)
      .map((record) => record.artifactId)
      .sort();
    if (canonicalJson(topLevelIds) !== canonicalJson(expectedArtifacts))
      fail(`${result.fixtureId}: top-level internal artifact closure differs`);
  }
  for (const artifact of runLock.artifacts) {
    const absolute = path.join(evidenceRoot, artifact.path);
    if (!existsSync(absolute) || sha256File(absolute) !== artifact.sha256)
      fail(
        `${result.fixtureId}: evidence artifact differs ${artifact.artifactId}`
      );
  }
}

console.log(
  `INTEGRATION_RUN_EVIDENCE_OK mode=${summary.mode} passed=${summary.counts.passed} waived=${summary.counts.waived} failed=${summary.counts.failed} selected=${summary.counts.selected}`
);
