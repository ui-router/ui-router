#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  matrixPath,
  repository,
  sha256File,
  validateIntegrationMatrix,
} from "./integration-matrix-lib.mjs";

function fail(message) {
  throw new Error(`INTEGRATION_EVIDENCE_VERIFY_FAILED: ${message}`);
}
const { matrix } = await validateIntegrationMatrix();
const evidencePath = path.join(
  repository,
  "migration/evidence/i02/integration-proof.json"
);
if (!existsSync(evidencePath)) fail("checked integration proof is missing");
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (
  evidence.schemaVersion !== 1 ||
  evidence.task !== "I02" ||
  evidence.owner !== matrix.owner ||
  evidence.matrixSha256 !== sha256File(path.join(repository, matrixPath)) ||
  evidence.mode !== "clean"
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
  passed: matrix.counts.runnable,
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
    result.status !== "pass" ||
    result.mode !== "clean" ||
    result.reused !== false ||
    !/^[a-f0-9]{24}$/.test(result.runId) ||
    !/^[a-f0-9]{64}$/.test(result.runLockSha256) ||
    path.isAbsolute(result.runLock)
  )
    fail(`${project.id}: proof result differs`);
}
const expectedArtifactIds = matrix.artifactPolicy.artifactIds;
const artifactIds = evidence.artifacts.map((record) => record.artifactId);
if (canonicalJson(artifactIds) !== canonicalJson(expectedArtifactIds))
  fail("proof artifact coverage differs");
for (const artifact of evidence.artifacts) {
  if (
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !artifact.filename.includes(`-sha256-${artifact.sha256}.tgz`) ||
    path.isAbsolute(artifact.path)
  )
    fail(`${artifact.artifactId}: proof artifact binding differs`);
}
console.log(
  `INTEGRATION_EVIDENCE_OK projects=${evidence.counts.passed} runnableEdges=${evidence.counts.logicalEdges} templateEdges=${templateEdges} browser=${evidence.counts.browserProjects} artifacts=${evidence.artifacts.length}`
);
