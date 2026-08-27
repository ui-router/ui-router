import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { validateJsonSchema } from "./validate-migration-contract.mjs";

export const repository = realpathSync(path.join(import.meta.dirname, ".."));
export const matrixPath = "migration/integration-matrix.json";
export const matrixSchemaPath =
  "migration/schemas/integration-matrix.schema.json";
export const runLockSchemaPath =
  "migration/schemas/integration-run-lock.schema.json";

export function fail(message) {
  throw new Error(`INTEGRATION_MATRIX_VERIFY_FAILED: ${message}`);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function sha256File(filename) {
  return sha256(readFileSync(filename));
}

export function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(
      `${label} differs\nexpected ${canonicalJson(
        expected
      )}\nactual   ${canonicalJson(actual)}`
    );
  }
}

export function assertUnique(records, selector, label) {
  const seen = new Set();
  for (const record of records) {
    const value = selector(record);
    if (seen.has(value)) fail(`${label} repeats ${value}`);
    seen.add(value);
  }
}

export function fixtureTreeRecords(root, manifest) {
  const directory = path.join(root, path.posix.dirname(manifest));
  const ignored = new Set([
    "node_modules",
    "dist",
    "coverage",
    ".cache",
    ".turbo",
  ]);
  const records = [];
  function walk(absolute, relative = "") {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      if (ignored.has(entry.name)) continue;
      const child = path.join(absolute, entry.name);
      const portable = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink())
        fail(`fixture tree contains symlink ${portable}`);
      if (entry.isDirectory()) walk(child, portable);
      else if (entry.isFile()) {
        const contents = readFileSync(child);
        records.push({
          path: portable,
          size: contents.length,
          sha256: sha256(contents),
        });
      } else fail(`fixture tree contains unsupported entry ${portable}`);
    }
  }
  walk(directory);
  return records;
}

export function fixtureTreeSha256(root, manifest) {
  return sha256(canonicalJson(fixtureTreeRecords(root, manifest)));
}

function externalGraphRecords(lock, publishedNames) {
  return Object.entries(lock.packages)
    .filter(
      ([key]) =>
        key &&
        !(
          key.startsWith("node_modules/") &&
          publishedNames.has(key.slice("node_modules/".length))
        )
    )
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export function externalGraph(root, lockPath, publishedNames) {
  if (!lockPath) return null;
  const lock = JSON.parse(readFileSync(path.join(root, lockPath), "utf8"));
  const records = externalGraphRecords(lock, publishedNames);
  return { sha256: sha256(canonicalJson(records)), records: records.length };
}

export function installedExternalGraph(lock, publishedNames) {
  const records = externalGraphRecords(lock, publishedNames);
  return { records, sha256: sha256(canonicalJson(records)) };
}

const REQUIRED_RESET_INPUTS = [
  "fixture-tree",
  "committed-lock",
  "matrix",
  "repository-revision",
  "platform-architecture",
  "node-npm",
  "npm-configuration",
  "browser",
  "tarballs",
  "package-artifacts-contract",
  "baselines-runtime",
  "external-graph",
  "installed-dependency-graph",
  "peer-graph",
  "command",
];
const REQUIRED_BUNDLE_CONTENTS = [
  "original-manifest",
  "original-lock-or-absence",
  "staged-manifest",
  "temporary-lock",
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
  "stdout",
  "stderr",
  "replay-reset-commands",
];

export async function validateIntegrationMatrix(
  root = repository,
  candidate = null,
  { skipSchema = false } = {}
) {
  root = realpathSync(root);
  const readJson = (relative) =>
    JSON.parse(readFileSync(path.join(root, relative), "utf8"));
  const matrix = candidate ?? readJson(matrixPath);
  if (!skipSchema) {
    try {
      await validateJsonSchema(matrix, path.join(root, matrixSchemaPath));
    } catch (error) {
      fail(`schema: ${error.message}`);
    }
  }
  const digestFiles = {
    isolatedProjectsSha256: "migration/isolated-projects.json",
    packageArtifactsSha256: "migration/package-artifacts.json",
    packageClassificationSha256: "migration/package-classification.json",
    pathRepairsSha256: "migration/path-repairs.json",
    baselinesSha256: "migration/baselines.json",
    executionLockSha256: "migration/execution-lock.json",
  };
  for (const [field, relative] of Object.entries(digestFiles)) {
    const actual = sha256File(path.join(root, relative));
    if (matrix[field] !== actual)
      fail(`${field} mismatch: expected ${actual}, got ${matrix[field]}`);
  }
  if (
    sha256File(path.join(root, matrix.evidence.path)) !== matrix.evidence.sha256
  )
    fail("top-level evidence digest differs");

  const isolated = readJson("migration/isolated-projects.json");
  const classification = readJson("migration/package-classification.json");
  const packageArtifacts = readJson("migration/package-artifacts.json");
  const baselines = readJson("migration/baselines.json");
  const artifactByPackage = new Map(
    packageArtifacts.packages.map((record) => [record.package, record])
  );
  const artifactById = new Map(
    packageArtifacts.packages.map((record) => [record.id, record])
  );
  const publishedNames = new Set(artifactByPackage.keys());
  const edgeById = new Map(
    classification.edges.map((record) => [record.id, record])
  );
  const baselineIds = new Set(baselines.entries.map((record) => record.id));
  const projectById = new Map(
    isolated.projects.map((record) => [record.id, record])
  );

  assertUnique(matrix.projects, (record) => record.id, "project id");
  assertUnique(
    matrix.projects,
    (record) => record.manifest,
    "project manifest"
  );
  assertEqual(
    matrix.projects.map((record) => record.id).sort(),
    [...projectById.keys()].sort(),
    "project inventory"
  );

  const allEdgeIds = [];
  const allRewriteIds = [];
  const allClosureBindingIds = [];
  const allRegistryRecords = [];
  const usedArtifactIds = new Set();
  for (const project of matrix.projects) {
    const source = projectById.get(project.id);
    if (!source) fail(`${project.id}: not in I01 contract`);
    for (const field of [
      "mode",
      "manifest",
      "sourceManifest",
      "name",
      "generatorScript",
      "manifestBaselineId",
    ]) {
      assertEqual(project[field], source[field], `${project.id} ${field}`);
    }
    assertEqual(
      project.committedManifestSha256,
      source.manifestSha256,
      `${project.id} committed manifest digest`
    );
    assertEqual(
      project.commands,
      {
        ...source.commands,
        selected: source.mode === "runnable" ? source.commands.test : null,
      },
      `${project.id} commands`
    );
    assertEqual(
      project.downstreamBaselineIds,
      source.downstreamBaselineIds,
      `${project.id} baseline IDs`
    );
    if (!baselineIds.has(project.manifestBaselineId))
      fail(
        `${project.id}: missing manifest baseline ${project.manifestBaselineId}`
      );
    for (const id of project.downstreamBaselineIds)
      if (!baselineIds.has(id)) fail(`${project.id}: missing baseline ${id}`);
    assertEqual(
      project.registryBaselineRecords,
      source.registryBaselineRecords,
      `${project.id} registry baseline records`
    );
    allRegistryRecords.push(...project.registryBaselineRecords);
    assertEqual(
      project.edgeIds,
      source.internalEdgeIds,
      `${project.id} edge IDs`
    );
    allEdgeIds.push(...project.edgeIds);

    const manifestFile = path.join(root, project.manifest);
    if (sha256File(manifestFile) !== project.committedManifestSha256)
      fail(`${project.id}: committed manifest digest differs`);
    if (fixtureTreeSha256(root, project.manifest) !== project.fixtureTreeSha256)
      fail(`${project.id}: fixture tree digest differs`);
    if (
      sha256File(path.join(root, project.evidence.path)) !==
      project.evidence.sha256
    )
      fail(`${project.id}: evidence digest differs`);

    if (source.mode === "runnable") {
      assertEqual(project.committedLock, source.lock, `${project.id} lock`);
      if (!project.committedLock) fail(`${project.id}: runnable lock missing`);
      if (
        sha256File(path.join(root, project.committedLock.path)) !==
        project.committedLock.sha256
      )
        fail(`${project.id}: committed lock digest differs`);
      if (project.stagingPolicy !== "execute-external-copy")
        fail(`${project.id}: runnable staging policy differs`);
      if (project.commands.selected !== project.commands.test)
        fail(`${project.id}: selected command must be test`);
      if (project.expectedResult === "inventory-only")
        fail(`${project.id}: runnable project cannot be inventory-only`);
      if (project.expectedResult === "pass") {
        if (project.waiver !== null || project.expectedFailure !== null)
          fail(`${project.id}: passing project has failure policy`);
      } else if (project.expectedResult === "waived-failure") {
        if (!project.waiver || !project.expectedFailure)
          fail(`${project.id}: waived failure lacks policy`);
        if (new Date(`${project.waiver.expires}T00:00:00Z`) <= new Date())
          fail(`${project.id}: waiver is expired`);
      } else fail(`${project.id}: unsupported expected result`);
    } else {
      if (project.committedLock !== null)
        fail(`${project.id}: template must remain lockless`);
      if (project.commands.selected !== null)
        fail(`${project.id}: template must not select execution command`);
      if (project.stagingPolicy !== "validate-template-rewrites-only")
        fail(`${project.id}: template staging policy differs`);
      if (
        project.expectedResult !== "inventory-only" ||
        project.waiver !== null ||
        project.expectedFailure !== null
      )
        fail(`${project.id}: template result policy differs`);
    }
    if (project.browser !== Boolean(source.commands.setupBrowser))
      fail(`${project.id}: browser classification differs`);
    const projectLock = project.committedLock
      ? readJson(project.committedLock.path)
      : null;
    const lockBrowser = projectLock?.packages["node_modules/@playwright/test"];
    const lockBrowserCore =
      projectLock?.packages["node_modules/playwright-core"];
    const lockBrowserLauncher =
      projectLock?.packages["node_modules/playwright"];
    if (project.browser) {
      if (
        !lockBrowser ||
        lockBrowser.version !== matrix.browser.installerVersion ||
        lockBrowser.integrity !== matrix.browser.installerIntegrity
      )
        fail(`${project.id}: Playwright installer lock provenance differs`);
      if (
        !lockBrowserLauncher ||
        lockBrowserLauncher.version !== matrix.browser.launcherVersion ||
        lockBrowserLauncher.integrity !== matrix.browser.launcherIntegrity
      )
        fail(`${project.id}: Playwright launcher lock provenance differs`);
      if (
        !lockBrowserCore ||
        lockBrowserCore.version !== matrix.browser.installerVersion ||
        lockBrowserCore.integrity !== matrix.browser.coreIntegrity
      )
        fail(`${project.id}: Playwright core lock provenance differs`);
    } else if (lockBrowser || lockBrowserCore || lockBrowserLauncher)
      fail(`${project.id}: unexpected Playwright lock entry`);

    const groups = new Map();
    for (const edgeId of source.internalEdgeIds) {
      const edge = edgeById.get(edgeId);
      if (!edge) fail(`${project.id}: classification edge ${edgeId} missing`);
      const group = groups.get(edge.package) ?? [];
      group.push(edge);
      groups.set(edge.package, group);
    }
    const expectedRewrites = [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([packageName, edges]) => {
        const artifact = artifactByPackage.get(packageName);
        if (!artifact)
          fail(`${project.id}: no P01 artifact for ${packageName}`);
        const declared = edges.filter(
          (edge) => edge.manifestSection !== "legacy-injected"
        );
        if (declared.length > 1)
          fail(`${project.id}: multiple declared edges for ${packageName}`);
        const versions = new Set(edges.map((edge) => edge.expectedVersion));
        if (versions.size !== 1)
          fail(`${project.id}: edge versions disagree for ${packageName}`);
        const edgeIds = edges.map((edge) => edge.id).sort();
        const declaration = declared[0];
        const manifest = readJson(project.manifest);
        const section = declaration?.manifestSection ?? "dependencies";
        return {
          id: `rewrite-${project.id.replaceAll("/", "-")}-${artifact.id}`,
          owner: "ui-router-maintainers",
          package: packageName,
          artifactId: artifact.id,
          expectedVersion: [...versions][0],
          operation: declaration ? "replace-declared" : "inject-legacy",
          manifestSection: section,
          declaredSpec: declaration
            ? manifest[section]?.[packageName] ?? null
            : null,
          edgeIds,
          evidence: edgeIds.map((id) => edgeById.get(id).evidence),
        };
      });
    assertEqual(project.rewrites, expectedRewrites, `${project.id} rewrites`);
    assertEqual(
      project.rewriteIds,
      expectedRewrites.map((record) => record.id),
      `${project.id} rewrite IDs`
    );
    allRewriteIds.push(...project.rewriteIds);
    for (const rewrite of project.rewrites) {
      usedArtifactIds.add(rewrite.artifactId);
      const artifact = artifactById.get(rewrite.artifactId);
      if (!artifact || artifact.package !== rewrite.package)
        fail(`${project.id}: rewrite artifact/package mismatch`);
    }
    const directArtifactIds = new Set(
      project.rewrites.map((rewrite) => rewrite.artifactId)
    );
    const closureArtifactIds = new Set(directArtifactIds);
    const pendingArtifactIds = [...directArtifactIds];
    while (pendingArtifactIds.length) {
      const parent = artifactById.get(pendingArtifactIds.shift());
      for (const edgeId of parent.internalEdgeIds ?? []) {
        const edge = edgeById.get(edgeId);
        const dependency = artifactByPackage.get(edge.package);
        if (!dependency)
          fail(`${project.id}: P01 internal closure lacks ${edge.package}`);
        if (!closureArtifactIds.has(dependency.id)) {
          closureArtifactIds.add(dependency.id);
          pendingArtifactIds.push(dependency.id);
        }
      }
    }
    const expectedClosureBindings = [...closureArtifactIds]
      .filter((artifactId) => !directArtifactIds.has(artifactId))
      .sort()
      .map((artifactId) => {
        const artifact = artifactById.get(artifactId);
        const requiredByArtifactIds = [];
        const productionEdgeIds = [];
        for (const parentId of closureArtifactIds) {
          const parent = artifactById.get(parentId);
          for (const edgeId of parent.internalEdgeIds ?? []) {
            if (edgeById.get(edgeId).package === artifact.package) {
              requiredByArtifactIds.push(parentId);
              productionEdgeIds.push(edgeId);
            }
          }
        }
        return {
          id: `closure-${project.id.replaceAll("/", "-")}-${artifactId}`,
          owner: "ui-router-maintainers",
          artifactId,
          package: artifact.package,
          expectedVersion: artifact.version,
          manifestSection: "devDependencies",
          requiredByArtifactIds: [...new Set(requiredByArtifactIds)].sort(),
          productionEdgeIds: [...new Set(productionEdgeIds)].sort(),
          evidence: {
            path: "migration/package-artifacts.json",
            sha256: matrix.packageArtifactsSha256,
          },
        };
      });
    assertEqual(
      project.closureBindings,
      expectedClosureBindings,
      `${project.id} P01 internal closure bindings`
    );
    allClosureBindingIds.push(
      ...project.closureBindings.map((binding) => binding.id)
    );
    for (const binding of project.closureBindings)
      usedArtifactIds.add(binding.artifactId);
    assertEqual(
      project.externalGraph,
      externalGraph(root, project.committedLock?.path, publishedNames),
      `${project.id} external graph`
    );
    assertUnique(
      project.allowedExternalGraphChanges,
      (change) => change.key,
      `${project.id} allowed external graph change`
    );
    if (project.mode === "template") {
      if (
        project.expectedExternalGraphSha256 !== null ||
        project.allowedExternalGraphChanges.length !== 0
      )
        fail(
          `${project.id}: template must not define an executable external graph`
        );
    } else {
      const committedLock = readJson(project.committedLock.path);
      const beforeRecords = installedExternalGraph(
        committedLock,
        publishedNames
      ).records;
      const afterByKey = new Map(
        beforeRecords.map((record) => [record.key, record.value])
      );
      const projectArtifactIds = new Set([
        ...project.rewrites.map((rewrite) => rewrite.artifactId),
        ...project.closureBindings.map((binding) => binding.artifactId),
      ]);
      for (const change of project.allowedExternalGraphChanges) {
        if (
          change.key.startsWith("node_modules/") &&
          publishedNames.has(change.key.slice("node_modules/".length))
        )
          fail(
            `${project.id}: internal package listed as external graph change`
          );
        assertEqual(
          afterByKey.get(change.key) ?? null,
          change.before,
          `${project.id} external graph before ${change.key}`
        );
        if (canonicalJson(change.before) === canonicalJson(change.after))
          fail(`${project.id}: no-op external graph change ${change.key}`);
        for (const artifactId of change.triggeringArtifactIds)
          if (!projectArtifactIds.has(artifactId))
            fail(
              `${project.id}: graph change has unrelated artifact ${artifactId}`
            );
        if (
          sha256File(path.join(root, change.evidence.path)) !==
          change.evidence.sha256
        )
          fail(
            `${project.id}: graph-change evidence differs for ${change.key}`
          );
        if (change.after === null) afterByKey.delete(change.key);
        else afterByKey.set(change.key, change.after);
      }
      const expectedAfter = [...afterByKey.entries()]
        .map(([key, value]) => ({ key, value }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const expectedAfterSha256 = sha256(canonicalJson(expectedAfter));
      if (project.expectedExternalGraphSha256 !== expectedAfterSha256)
        fail(`${project.id}: expected staged external graph digest differs`);
    }
  }

  assertUnique(allEdgeIds, (id) => id, "logical edge coverage");
  assertUnique(allRewriteIds, (id) => id, "rewrite id");
  assertUnique(allClosureBindingIds, (id) => id, "closure binding id");
  assertEqual(
    allEdgeIds.sort(),
    isolated.projects.flatMap((project) => project.internalEdgeIds).sort(),
    "complete logical edge coverage"
  );
  assertEqual(
    [...usedArtifactIds].sort(),
    matrix.artifactPolicy.artifactIds,
    "artifact ID coverage"
  );
  for (const id of usedArtifactIds)
    if (!artifactById.has(id)) fail(`unknown artifact ID ${id}`);

  const derivedCounts = {
    projects: matrix.projects.length,
    runnable: matrix.projects.filter((project) => project.mode === "runnable")
      .length,
    templates: matrix.projects.filter((project) => project.mode === "template")
      .length,
    browserProjects: matrix.projects.filter((project) => project.browser)
      .length,
    logicalEdges: allEdgeIds.length,
    rewriteOperations: allRewriteIds.length,
    closureBindings: allClosureBindingIds.length,
    waivedFailures: matrix.projects.filter(
      (project) => project.expectedResult === "waived-failure"
    ).length,
    registryBaselineRecords: allRegistryRecords.length,
    artifactIds: usedArtifactIds.size,
  };
  assertEqual(matrix.counts, derivedCounts, "derived counts");
  const derivedNpxProjects = matrix.projects
    .filter((project) => {
      const directory = path.join(root, path.posix.dirname(project.manifest));
      return readdirSync(directory)
        .filter((name) => /^playwright\.config\./.test(name))
        .some((name) =>
          /\bnpx\s+serve\b/.test(
            readFileSync(path.join(directory, name), "utf8")
          )
        );
    })
    .map((project) => project.id)
    .sort();
  assertUnique(
    matrix.commandAdapters,
    (adapter) => adapter.id,
    "command adapter id"
  );
  if (matrix.commandAdapters.length !== 1)
    fail("exactly one reviewed command adapter is required");
  const commandAdapter = matrix.commandAdapters[0];
  assertEqual(
    commandAdapter.allowedProjects,
    derivedNpxProjects,
    "npx serve adapter project coverage"
  );
  if (
    sha256File(path.join(root, commandAdapter.script)) !==
    commandAdapter.scriptSha256
  )
    fail("command adapter script digest differs");
  if (!(lstatSync(path.join(root, commandAdapter.script)).mode & 0o111))
    fail("command adapter script must be executable");

  assertEqual(matrix.resetInputs, REQUIRED_RESET_INPUTS, "reset inputs");
  assertEqual(
    matrix.failureBundleContents,
    REQUIRED_BUNDLE_CONTENTS,
    "failure bundle contents"
  );
  if (
    matrix.runtime.forbiddenEnvironment.length !== 1 ||
    matrix.runtime.forbiddenEnvironment[0] !== "NODE_PATH"
  )
    fail("NODE_PATH must be the sole forbidden inherited environment key");
  if (matrix.networkPolicy.internalRegistryFallback !== "forbidden")
    fail("internal registry fallback must be forbidden");
  if (
    matrix.artifactPolicy.metadataDirectoryName !==
    packageArtifacts.artifactPolicy.directory
  )
    fail("P01 artifact directory binding differs");

  return {
    matrix,
    isolated,
    classification,
    packageArtifacts,
    baselines,
    artifactById,
    artifactByPackage,
    edgeById,
    publishedNames,
  };
}

export function isInside(parent, candidate) {
  const relative = path.relative(realpathSync(parent), realpathSync(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function assertExternalSandbox(root, sandbox) {
  const realRoot = realpathSync(root);
  const realSandbox = realpathSync(sandbox);
  if (isInside(realRoot, realSandbox) || isInside(realSandbox, realRoot))
    fail(`sandbox must be outside repository ancestry: ${realSandbox}`);
}

export function assertNoLinksOrSharedFiles(sourceRoot, copyRoot) {
  if (
    lstatSync(sourceRoot).isSymbolicLink() ||
    lstatSync(copyRoot).isSymbolicLink()
  )
    fail("source/copy root must not be a symbolic link");
  const sourceFiles = new Map();
  function collect(directory, output, relative = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        ["node_modules", "dist", "coverage", ".cache", ".turbo"].includes(
          entry.name
        )
      )
        continue;
      const child = path.join(directory, entry.name);
      const portable = path.join(relative, entry.name);
      const info = lstatSync(child);
      if (info.isSymbolicLink()) fail(`sandbox scan found symlink ${child}`);
      if (info.isDirectory()) collect(child, output, portable);
      else if (info.isFile()) output.set(portable, info);
      else fail(`sandbox scan found unsupported entry ${child}`);
    }
  }
  collect(sourceRoot, sourceFiles);
  const copyFiles = new Map();
  collect(copyRoot, copyFiles);
  for (const [relative, info] of copyFiles) {
    const source = sourceFiles.get(relative);
    if (source && source.dev === info.dev && source.ino === info.ino)
      fail(`sandbox contains hard link to source: ${relative}`);
  }
  return sha256(
    canonicalJson(
      [...copyFiles.entries()]
        .map(([relative]) => ({ path: relative, type: "file" }))
        .sort((left, right) => left.path.localeCompare(right.path))
    )
  );
}
