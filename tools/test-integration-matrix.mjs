#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  matrixPath,
  repository,
  validateIntegrationMatrix,
} from "./integration-matrix-lib.mjs";

const original = JSON.parse(
  readFileSync(path.join(repository, matrixPath), "utf8")
);
const clone = () => structuredClone(original);
const cases = [
  ["omitted project", (value) => value.projects.pop()],
  [
    "duplicate project id",
    (value) => (value.projects[1].id = value.projects[0].id),
  ],
  [
    "duplicate manifest",
    (value) => (value.projects[1].manifest = value.projects[0].manifest),
  ],
  ["omitted logical edge", (value) => value.projects[0].edgeIds.pop()],
  [
    "duplicate logical edge",
    (value) => value.projects[1].edgeIds.push(value.projects[0].edgeIds[0]),
  ],
  ["omitted rewrite", (value) => value.projects[0].rewrites.pop()],
  [
    "artifact mismatch",
    (value) => (value.projects[0].rewrites[0].artifactId = "react"),
  ],
  [
    "version mismatch",
    (value) => (value.projects[0].rewrites[0].expectedVersion = "0.0.0"),
  ],
  [
    "undeclared section",
    (value) =>
      (value.projects[0].rewrites[0].manifestSection = "devDependencies"),
  ],
  [
    "legacy operation mismatch",
    (value) =>
      (value.projects.find(
        (item) => item.id === "framework/react/integration/react17"
      ).rewrites[0].operation = "replace-declared"),
  ],
  [
    "template made runnable",
    (value) =>
      (value.projects.find((item) => item.mode === "template").mode =
        "runnable"),
  ],
  [
    "template lock fabricated",
    (value) =>
      (value.projects.find((item) => item.mode === "template").committedLock =
        value.projects[0].committedLock),
  ],
  [
    "runnable lock omitted",
    (value) => (value.projects[0].committedLock = null),
  ],
  [
    "baseline omitted",
    (value) => value.projects[0].downstreamBaselineIds.pop(),
  ],
  [
    "registry baseline changed",
    (value) => (value.projects[0].registryBaselineRecords[0].version = "0.0.0"),
  ],
  [
    "external graph changed",
    (value) => (value.projects[0].externalGraph.sha256 = "0".repeat(64)),
  ],
  [
    "expected staged graph changed",
    (value) =>
      (value.projects.find(
        (item) => item.allowedExternalGraphChanges.length
      ).expectedExternalGraphSha256 = "0".repeat(64)),
  ],
  [
    "unapproved external graph addition",
    (value) =>
      value.projects
        .find((item) => item.allowedExternalGraphChanges.length)
        .allowedExternalGraphChanges.push({
          ...value.projects.find(
            (item) => item.allowedExternalGraphChanges.length
          ).allowedExternalGraphChanges[0],
          key: "node_modules/unapproved",
        }),
  ],
  [
    "graph trigger mismatch",
    (value) =>
      (value.projects.find(
        (item) => item.allowedExternalGraphChanges.length
      ).allowedExternalGraphChanges[0].triggeringArtifactIds = [
        "react-hybrid",
      ]),
  ],
  [
    "fixture tree changed",
    (value) => (value.projects[0].fixtureTreeSha256 = "0".repeat(64)),
  ],
  [
    "contract digest changed",
    (value) => (value.packageArtifactsSha256 = "0".repeat(64)),
  ],
  ["reset input omitted", (value) => value.resetInputs.pop()],
  ["failure bundle item omitted", (value) => value.failureBundleContents.pop()],
  [
    "internal fallback enabled",
    (value) => (value.networkPolicy.internalRegistryFallback = "allowed"),
  ],
  [
    "NODE_PATH policy omitted",
    (value) => (value.runtime.forbiddenEnvironment = []),
  ],
  [
    "force lock generation",
    (value) => value.lockPolicy.lockArgv.push("--force"),
  ],
  [
    "command adapter omission",
    (value) => value.commandAdapters[0].allowedProjects.pop(),
  ],
  [
    "command adapter tampering",
    (value) => (value.commandAdapters[0].scriptSha256 = "0".repeat(64)),
  ],
  [
    "selected e2e bypass",
    (value) =>
      (value.projects.find((item) => item.commands.e2e).commands.selected =
        "e2e"),
  ],
  [
    "browser misclassified",
    (value) => (value.projects.find((item) => item.browser).browser = false),
  ],
];

let passed = 0;
for (const [name, mutate] of cases) {
  const candidate = clone();
  mutate(candidate);
  try {
    await validateIntegrationMatrix(repository, candidate);
    throw new Error(`mutation unexpectedly passed: ${name}`);
  } catch (error) {
    if (String(error.message).startsWith("mutation unexpectedly passed"))
      throw error;
    passed += 1;
  }
}
console.log(`INTEGRATION_MATRIX_ADVERSARIAL_OK cases=${passed}`);
