#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyEdits, modify } from "jsonc-parser";

import { fixtureTreeSha256 } from "./integration-matrix-lib.mjs";
import { scriptsSha256 } from "./package-artifacts-lib.mjs";
import { renderWorkflow } from "./render-ci-workflow.mjs";
import { renderReproducibilityWorkflow } from "./render-reproducibility-workflow.mjs";

const repository = realpathSync(path.join(import.meta.dirname, ".."));
const write = process.argv.includes("--write");
const restoreHeadFormat = process.argv.includes("--restore-head-format");
const unexpected = process.argv
  .slice(2)
  .filter(
    (argument) => argument !== "--write" && argument !== "--restore-head-format"
  );

if (unexpected.length)
  throw new Error(`unknown arguments: ${unexpected.join(" ")}`);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

const virtualFiles = new Map();

function readText(relative) {
  return (
    virtualFiles.get(relative) ??
    readFileSync(path.join(repository, relative), "utf8")
  );
}

function sha256File(relative) {
  return sha256(readText(relative));
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function patchJson(text, before, after, jsonPath = []) {
  if (equal(before, after)) return text;

  const beforeIsArray = Array.isArray(before);
  const afterIsArray = Array.isArray(after);
  if (beforeIsArray && afterIsArray && before.length === after.length) {
    return after.reduce(
      (result, value, index) =>
        patchJson(result, before[index], value, [...jsonPath, index]),
      text
    );
  }

  const beforeIsObject =
    before !== null && typeof before === "object" && !beforeIsArray;
  const afterIsObject =
    after !== null && typeof after === "object" && !afterIsArray;
  if (beforeIsObject && afterIsObject) {
    let result = text;
    for (const key of Object.keys(before)) {
      if (!(key in after))
        result = applyEdits(
          result,
          modify(result, [...jsonPath, key], undefined, {})
        );
    }
    for (const key of Object.keys(after)) {
      result =
        key in before
          ? patchJson(result, before[key], after[key], [...jsonPath, key])
          : applyEdits(
              result,
              modify(result, [...jsonPath, key], after[key], {
                formattingOptions: {
                  insertSpaces: true,
                  tabSize: 2,
                  eol: "\n",
                },
              })
            );
    }
    return result;
  }

  return applyEdits(
    text,
    modify(text, jsonPath, after, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })
  );
}

function headText(relative) {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "show", `HEAD:${relative}`],
    { cwd: repository, encoding: "utf8" }
  );
  if (result.status !== 0)
    throw new Error(`cannot read HEAD formatting for ${relative}`);
  return result.stdout;
}

const changes = [];
function update(object, field, value, label) {
  if (object[field] !== value) {
    changes.push(label);
    object[field] = value;
  }
}

function writeJson(relative, value) {
  const current = readFileSync(path.join(repository, relative), "utf8");
  const base = restoreHeadFormat ? headText(relative) : current;
  const next = patchJson(base, JSON.parse(base), value);
  virtualFiles.set(relative, next);
  if (current !== next) {
    if (write) writeFileSync(path.join(repository, relative), next);
    changes.push(relative);
  }
}

function refreshBindings(contract, files) {
  for (const [field, relative] of Object.entries(files))
    update(contract.bindings, field, sha256File(relative), `${field} binding`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function refreshMatrixProject(project, isolatedById) {
  const source = isolatedById.get(project.id);
  if (!source)
    throw new Error(`integration project is not isolated: ${project.id}`);

  const manifestSha256 = sha256File(project.manifest);
  update(
    source,
    "manifestSha256",
    manifestSha256,
    `${project.id} isolated manifest`
  );
  update(
    project,
    "committedManifestSha256",
    manifestSha256,
    `${project.id} matrix manifest`
  );
  update(
    project,
    "fixtureTreeSha256",
    fixtureTreeSha256(repository, project.manifest),
    `${project.id} fixture tree`
  );
  update(
    project.evidence,
    "sha256",
    sha256File(project.evidence.path),
    `${project.id} evidence`
  );

  if (!project.committedLock) return;
  const lockSha256 = sha256File(project.committedLock.path);
  update(source.lock, "sha256", lockSha256, `${project.id} isolated lock`);
  update(
    project.committedLock,
    "sha256",
    lockSha256,
    `${project.id} matrix lock`
  );

  const beforeLock = readJson(project.committedLock.path);
  const before = new Map(
    Object.entries(beforeLock.packages)
      .filter(([key]) => key && !key.startsWith("node_modules/@uirouter/"))
      .map(([key, value]) => [key, value])
  );
  for (const change of project.allowedExternalGraphChanges) {
    if (change.after === null) before.delete(change.key);
    else before.set(change.key, change.after);
  }
  const expectedAfter = [...before.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));
  update(
    project,
    "expectedExternalGraphSha256",
    sha256(canonicalJson(expectedAfter)),
    `${project.id} external graph`
  );
}

const packageArtifacts = readJson("migration/package-artifacts.json");
for (const [field, relative] of Object.entries({
  packageClassificationSha256: "migration/package-classification.json",
  pathRepairsSha256: "migration/path-repairs.json",
  sourceAliasesSha256: "migration/source-aliases.json",
  turboJsonSha256: "turbo.json",
}))
  update(
    packageArtifacts,
    field,
    sha256File(relative),
    `package artifact ${field}`
  );
update(
  packageArtifacts,
  "rootLockSha256",
  sha256File("package-lock.json"),
  "package artifact root lock"
);
update(
  packageArtifacts,
  "rootLockPackageEntries",
  Object.keys(readJson("package-lock.json").packages).length,
  "package artifact root lock entries"
);
for (const record of packageArtifacts.packages) {
  const manifest = readJson(record.manifest);
  update(record, "version", manifest.version, `${record.id} package version`);
  update(
    record,
    "manifestSha256",
    sha256File(record.manifest),
    `${record.id} package manifest`
  );
  update(
    record,
    "scriptsSha256",
    scriptsSha256(manifest),
    `${record.id} package scripts`
  );
}
writeJson("migration/package-artifacts.json", packageArtifacts);
const artifactById = new Map(
  packageArtifacts.packages.map((record) => [record.id, record])
);

const isolated = readJson("migration/isolated-projects.json");
const isolatedById = new Map(
  isolated.projects.map((project) => [project.id, project])
);
const matrix = readJson("migration/integration-matrix.json");
for (const project of matrix.projects)
  refreshMatrixProject(project, isolatedById);
writeJson("migration/isolated-projects.json", isolated);

update(
  matrix,
  "isolatedProjectsSha256",
  sha256File("migration/isolated-projects.json"),
  "isolated projects binding"
);
update(
  matrix,
  "packageArtifactsSha256",
  sha256File("migration/package-artifacts.json"),
  "package artifacts binding"
);
for (const project of matrix.projects) {
  for (const rewrite of project.rewrites) {
    const artifact = artifactById.get(rewrite.artifactId);
    if (!artifact)
      throw new Error(
        `${project.id} rewrite has unknown artifact ${rewrite.artifactId}`
      );
    update(
      rewrite,
      "expectedVersion",
      artifact.version,
      `${project.id} rewrite version`
    );
  }
  for (const binding of project.closureBindings) {
    const artifact = artifactById.get(binding.artifactId);
    if (!artifact)
      throw new Error(
        `${project.id} closure has unknown artifact ${binding.artifactId}`
      );
    update(
      binding,
      "expectedVersion",
      artifact.version,
      `${project.id} closure version`
    );
    if (binding.evidence.path === "migration/package-artifacts.json")
      update(
        binding.evidence,
        "sha256",
        matrix.packageArtifactsSha256,
        `${project.id} closure binding`
      );
  }
  for (const change of project.allowedExternalGraphChanges) {
    if (change.evidence.path === "migration/package-artifacts.json")
      update(
        change.evidence,
        "sha256",
        matrix.packageArtifactsSha256,
        `${project.id} graph-change binding`
      );
  }
}
for (const retirement of matrix.retirements)
  update(
    retirement.evidence,
    "sha256",
    sha256File(retirement.evidence.path),
    `${retirement.projectId} retirement evidence`
  );
writeJson("migration/integration-matrix.json", matrix);

const ci = readJson("migration/ci-gates.json");
refreshBindings(ci, {
  baselinesSha256: "migration/baselines.json",
  packageClassificationSha256: "migration/package-classification.json",
  sourceAliasesSha256: "migration/source-aliases.json",
  packageArtifactsSha256: "migration/package-artifacts.json",
  integrationMatrixSha256: "migration/integration-matrix.json",
  executionLockSha256: "migration/execution-lock.json",
  packageLockSha256: "package-lock.json",
  turboSha256: "turbo.json",
});
writeJson("migration/ci-gates.json", ci);
const ciWorkflow = renderWorkflow(ci);
if (
  readFileSync(path.join(repository, ".github/workflows/ci.yml"), "utf8") !==
  ciWorkflow
) {
  if (write)
    writeFileSync(
      path.join(repository, ".github/workflows/ci.yml"),
      ciWorkflow
    );
  changes.push(".github/workflows/ci.yml");
}

const reproducibility = readJson("migration/clean-reproducibility.json");
refreshBindings(reproducibility, {
  ciGatesSha256: "migration/ci-gates.json",
  packageJsonSha256: "package.json",
  packageLockSha256: "package-lock.json",
  turboSha256: "turbo.json",
  packageArtifactsSha256: "migration/package-artifacts.json",
  baselinesSha256: "migration/baselines.json",
  integrationMatrixSha256: "migration/integration-matrix.json",
  executionLockSha256: "migration/execution-lock.json",
});
writeJson("migration/clean-reproducibility.json", reproducibility);
const reproducibilityWorkflow = renderReproducibilityWorkflow(reproducibility);
if (
  readFileSync(
    path.join(repository, ".github/workflows/reproducibility.yml"),
    "utf8"
  ) !== reproducibilityWorkflow
) {
  if (write)
    writeFileSync(
      path.join(repository, ".github/workflows/reproducibility.yml"),
      reproducibilityWorkflow
    );
  changes.push(".github/workflows/reproducibility.yml");
}

const milestone = readJson("migration/milestone-acceptance.json");
refreshBindings(milestone, {
  sourcesSha256: "migration/sources.json",
  executionLockSha256: "migration/execution-lock.json",
  importLockSha256: "migration/import-lock.json",
  importEvidenceSha256: "migration/evidence/summary.json",
  baselinesSha256: "migration/baselines.json",
  packageClassificationSha256: "migration/package-classification.json",
  packageArtifactsSha256: "migration/package-artifacts.json",
  integrationMatrixSha256: "migration/integration-matrix.json",
  sourceAliasesSha256: "migration/source-aliases.json",
  pathRepairsSha256: "migration/path-repairs.json",
  ciGatesSha256: "migration/ci-gates.json",
  cleanReproducibilitySha256: "migration/clean-reproducibility.json",
  packageJsonSha256: "package.json",
  packageLockSha256: "package-lock.json",
  turboSha256: "turbo.json",
  workGraphSha256: "migration/work-graph.json",
});
writeJson("migration/milestone-acceptance.json", milestone);

const release = readJson("migration/release-cutover.json");
release.releaseInventory.packages = packageArtifacts.packages.map(
  ({ id, package: name, version }) => ({ id, name, version })
);
refreshBindings(release, {
  sourcesSha256: "migration/sources.json",
  packageArtifactsSha256: "migration/package-artifacts.json",
  packageClassificationSha256: "migration/package-classification.json",
  milestoneAcceptanceSha256: "migration/milestone-acceptance.json",
  cleanReproducibilitySha256: "migration/clean-reproducibility.json",
  workGraphSha256: "migration/work-graph.json",
  planDocumentSha256: "migration/release-cutover-plan.md",
});
writeJson("migration/release-cutover.json", release);

if (!changes.length) console.log("VALIDATION_BINDINGS_OK changes=0");
else if (write)
  console.log(
    `VALIDATION_BINDINGS_REFRESHED changes=${[...new Set(changes)].length}`
  );
else
  console.log(
    `VALIDATION_BINDINGS_OUTDATED changes=${
      [...new Set(changes)].length
    }; rerun with --write`
  );
