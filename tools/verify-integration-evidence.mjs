#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  matrixPath,
  repository,
  runLockSchemaPath,
  sha256,
  sha256File,
  validateIntegrationMatrix,
} from "./integration-matrix-lib.mjs";
import { validateJsonSchema } from "./validate-migration-contract.mjs";

function fail(message) {
  throw new Error(`INTEGRATION_EVIDENCE_VERIFY_FAILED: ${message}`);
}
const { matrix } = await validateIntegrationMatrix();
const evidencePath = path.join(
  repository,
  "migration/evidence/i02/integration-proof.json"
);
if (!existsSync(evidencePath)) fail("checked integration proof is missing");
const evidenceDirectory = path.dirname(evidencePath);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
function safeEvidencePath(relative, label) {
  if (path.isAbsolute(relative)) fail(`${label} must be relative`);
  const resolved = path.resolve(evidenceDirectory, relative);
  const relation = path.relative(evidenceDirectory, resolved);
  if (relation.startsWith("..") || path.isAbsolute(relation))
    fail(`${label} escapes checked evidence`);
  return resolved;
}
if (
  evidence.schemaVersion !== 1 ||
  evidence.task !== "I02" ||
  evidence.owner !== matrix.owner ||
  evidence.matrixSha256 !== sha256File(path.join(repository, matrixPath)) ||
  evidence.mode !== "clean" ||
  evidence.evidenceFormat !== "compact-schema-validated-run-locks"
)
  fail("proof identity differs");
if (
  evidence.runtime.platform !== matrix.runtime.platform ||
  evidence.runtime.architecture !== matrix.runtime.architecture ||
  evidence.runtime.node !== matrix.runtime.node ||
  evidence.runtime.npm !== matrix.runtime.npm ||
  evidence.runtime.imageDigest !== matrix.runtime.imageDigest ||
  canonicalJson(evidence.runtime.environment) !==
    canonicalJson(matrix.runtime.environment) ||
  canonicalJson(evidence.runtime.forbiddenEnvironmentAbsent) !==
    canonicalJson(matrix.runtime.forbiddenEnvironment)
)
  fail("proof runtime differs");
const runnable = matrix.projects.filter(
  (project) => project.mode === "runnable"
);
if (
  canonicalJson(evidence.selected) !==
  canonicalJson(runnable.map((project) => project.id))
)
  fail("proof runnable selection differs");
const expectedCounts = {
  selected: matrix.counts.runnable,
  passed: runnable.filter((project) => project.expectedResult === "pass")
    .length,
  waived: matrix.counts.waivedFailures,
  failed: 0,
  logicalEdges: runnable.reduce(
    (count, project) => count + project.edgeIds.length,
    0
  ),
  browserProjects: matrix.counts.browserProjects,
};
if (canonicalJson(evidence.counts) !== canonicalJson(expectedCounts))
  fail("proof result counts differ");
const templateEdges = matrix.projects
  .filter((project) => project.mode === "template")
  .reduce((count, project) => count + project.edgeIds.length, 0);
const expectedCoverage = {
  matrixProjects: matrix.counts.projects,
  runnableProjects: matrix.counts.runnable,
  templateProjects: matrix.counts.templates,
  matrixLogicalEdges: matrix.counts.logicalEdges,
  runnableLogicalEdges: expectedCounts.logicalEdges,
  templateLogicalEdges: templateEdges,
  browserProjects: matrix.counts.browserProjects,
};
if (canonicalJson(evidence.coverage) !== canonicalJson(expectedCoverage))
  fail("proof matrix coverage differs");
if (evidence.results.length !== runnable.length)
  fail("proof result inventory differs");
for (const [index, result] of evidence.results.entries()) {
  const project = runnable[index];
  if (
    result.fixtureId !== project.id ||
    result.status !== project.expectedResult ||
    result.mode !== "clean" ||
    result.reused !== false ||
    !/^[a-f0-9]{24}$/.test(result.runId) ||
    !/^[a-f0-9]{64}$/.test(result.runLockSha256) ||
    path.isAbsolute(result.runLock)
  )
    fail(`${project.id}: proof result differs`);
  const runLockPath = safeEvidencePath(
    result.runLock,
    `${project.id} run lock`
  );
  if (!existsSync(runLockPath))
    fail(`${project.id}: checked run lock is missing`);
  const runLock = JSON.parse(readFileSync(runLockPath, "utf8"));
  try {
    await validateJsonSchema(runLock, path.join(repository, runLockSchemaPath));
  } catch (error) {
    fail(`${project.id}: checked run-lock schema: ${error.message}`);
  }
  if (
    sha256(canonicalJson(runLock)) !== result.runLockSha256 ||
    runLock.runId !== result.runId ||
    runLock.fixtureId !== project.id ||
    runLock.mode !== "clean" ||
    runLock.bundleState !== "final" ||
    runLock.result.status !== project.expectedResult ||
    runLock.contracts.matrixSha256 !== evidence.matrixSha256
  )
    fail(`${project.id}: checked run-lock identity differs`);
  if (
    canonicalJson(runLock.origins.map((record) => record.edgeId).sort()) !==
      canonicalJson([...project.edgeIds].sort()) ||
    (project.expectedResult === "pass" &&
      runLock.origins.some((record) => record.status !== "verified"))
  )
    fail(`${project.id}: checked logical origins differ`);
  const expectedArtifactIds = [
    ...new Set([
      ...project.rewrites.map((record) => record.artifactId),
      ...project.closureBindings.map((record) => record.artifactId),
    ]),
  ].sort();
  const actualArtifactIds = runLock.artifacts
    .map((record) => record.artifactId)
    .sort();
  if (canonicalJson(actualArtifactIds) !== canonicalJson(expectedArtifactIds))
    fail(`${project.id}: checked artifact closure differs`);
  const topLevelInternalIds = runLock.internalPackages
    .filter((record) => record.lockPath === `node_modules/${record.package}`)
    .map((record) => record.artifactId)
    .sort();
  if (project.expectedResult === "pass") {
    if (
      canonicalJson(topLevelInternalIds) !==
        canonicalJson(expectedArtifactIds) ||
      runLock.internalPackages.some(
        (record) =>
          /^https?:/i.test(record.lockResolved) ||
          !record.insideSandbox ||
          record.symlink
      ) ||
      runLock.failureBundle !== null ||
      runLock.result.waiver !== null
    )
      fail(`${project.id}: checked internal package provenance differs`);
  } else if (
    !runLock.failureBundle ||
    canonicalJson(runLock.result.waiver) !== canonicalJson(project.waiver) ||
    !project.expectedFailure.contains.every((text) =>
      runLock.result.failureReason.includes(text)
    )
  )
    fail(`${project.id}: checked waiver evidence differs`);
  if (project.browser && project.expectedResult === "pass") {
    if (
      !runLock.browser ||
      runLock.browser.installerIntegrity !==
        matrix.browser.installerIntegrity ||
      runLock.browser.launcherIntegrity !== matrix.browser.launcherIntegrity ||
      runLock.browser.coreIntegrity !== matrix.browser.coreIntegrity ||
      !runLock.browser.executableFiles.length
    )
      fail(`${project.id}: checked browser provenance differs`);
  } else if (project.expectedResult === "pass" && runLock.browser !== null)
    fail(`${project.id}: unexpected checked browser evidence`);
}
const expectedArtifactIds = matrix.artifactPolicy.artifactIds;
const artifactManifestPath = safeEvidencePath(
  "artifact-hashes.json",
  "artifact hash manifest"
);
if (!existsSync(artifactManifestPath))
  fail("checked artifact hash manifest is missing");
const artifactManifest = JSON.parse(readFileSync(artifactManifestPath, "utf8"));
const artifactIds = evidence.artifacts.map((record) => record.artifactId);
if (canonicalJson(artifactIds) !== canonicalJson(expectedArtifactIds))
  fail("proof artifact coverage differs");
for (const artifact of evidence.artifacts) {
  if (
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !artifact.filename.includes(`-sha256-${artifact.sha256}.tgz`) ||
    artifact.path !== "artifact-hashes.json"
  )
    fail(`${artifact.artifactId}: proof artifact binding differs`);
}
const compactManifest = artifactManifest.map((artifact) => ({
  artifactId: artifact.artifactId,
  package: artifact.package,
  version: artifact.version,
  filename: artifact.filename,
  sha256: artifact.sha256,
  integrity: artifact.integrity,
}));
const compactProof = evidence.artifacts.map((artifact) => ({
  artifactId: artifact.artifactId,
  package: artifact.package,
  version: artifact.version,
  filename: artifact.filename,
  sha256: artifact.sha256,
  integrity: artifact.integrity,
}));
if (canonicalJson(compactManifest) !== canonicalJson(compactProof))
  fail("proof artifacts differ from the checked hash manifest");
console.log(
  `INTEGRATION_EVIDENCE_OK projects=${evidence.counts.passed} runnableEdges=${evidence.counts.logicalEdges} templateEdges=${templateEdges} browser=${evidence.counts.browserProjects} artifacts=${evidence.artifacts.length}`
);
