#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
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
function git(args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    fail(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function decodeCheckedArchive(pathname) {
  const record = JSON.parse(readFileSync(pathname, "utf8"));
  if (
    record.encoding !== "base64" ||
    typeof record.filename !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  )
    fail(`checked archive encoding is invalid: ${pathname}`);
  const bytes = Buffer.from(record.bytes, "base64");
  if (bytes.length !== record.size || sha256(bytes) !== record.sha256)
    fail(`checked archive bytes differ: ${pathname}`);
  return { ...record, bytes };
}
function encodedArchiveDirectorySha256(directory) {
  const records = [];
  for (const filename of readdirSync(directory).sort()) {
    const absolute = path.join(directory, filename);
    if (filename === "hashes.json") {
      const bytes = readFileSync(absolute);
      records.push({
        path: filename,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    } else if (filename.endsWith(".tgz.json")) {
      const archive = decodeCheckedArchive(absolute);
      records.push({
        path: archive.filename,
        size: archive.size,
        sha256: archive.sha256,
      });
    } else fail(`unexpected encoded archive evidence: ${filename}`);
  }
  return sha256(
    canonicalJson(
      records.sort((left, right) => left.path.localeCompare(right.path))
    )
  );
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
        fail(`checked evidence contains symlink ${portable}`);
      if (info.isDirectory()) walk(child, portable);
      else if (info.isFile()) {
        const bytes = readFileSync(child);
        records.push({
          path: portable,
          size: bytes.length,
          sha256: sha256(bytes),
        });
      } else fail(`checked evidence contains unsupported entry ${portable}`);
    }
  }
  walk(directory);
  return sha256(canonicalJson(records));
}
const { matrix } = await validateIntegrationMatrix();
const evidencePath = path.join(
  repository,
  "migration/evidence/i02/integration-proof.json"
);
if (!existsSync(evidencePath)) fail("checked integration proof is missing");
const evidenceDirectory = path.dirname(evidencePath);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
function safeEvidencePath(relative, label, root = evidenceDirectory) {
  if (path.isAbsolute(relative)) fail(`${label} must be relative`);
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
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
const implementationCommit = evidence.repository.commit;
if (
  evidence.repository.dirty !== false ||
  git(["rev-parse", `${implementationCommit}^{tree}`]) !==
    evidence.repository.tree ||
  spawnSync(
    "git",
    ["merge-base", "--is-ancestor", implementationCommit, "HEAD"],
    {
      cwd: repository,
    }
  ).status !== 0
)
  fail("proof implementation commit/tree is not an ancestor of HEAD");
const evidencePrefix = "migration/evidence/i02/";
const postImplementationPaths = new Set(
  git(["diff", "--name-only", `${implementationCommit}..HEAD`])
    .split("\n")
    .filter(Boolean)
);
const statusResult = spawnSync("git", ["status", "--porcelain"], {
  cwd: repository,
  encoding: "utf8",
});
if (statusResult.status !== 0)
  fail(`git status --porcelain failed: ${statusResult.stderr}`);
for (const line of statusResult.stdout.split("\n").filter(Boolean))
  postImplementationPaths.add(line.slice(3).split(" -> ").at(-1));
const c01OwnedPaths = new Set([
  ".github/workflows/ci.yml",
  ".gitignore",
  "frameworks/angular-hybrid/examples/example/tsconfig.json",
  "frameworks/angular-hybrid/examples/example/webpack.config.js",
  "frameworks/angular-hybrid/examples/sample-app/tsconfig.json",
  "frameworks/react/examples/sample-app/vite.config.js",
  "migration/ci-gates.json",
  "migration/schemas/ci-gates.schema.json",
  "package.json",
  "plugins/dsr/examples/angular-cli/src/app/about.component.ts",
  "plugins/dsr/examples/angular-cli/src/app/app.component.ts",
  "plugins/dsr/examples/angular-cli/src/app/continentList.component.ts",
  "plugins/dsr/examples/angular-cli/src/app/countryDetail.component.ts",
  "plugins/dsr/examples/angular-cli/src/app/countryList.component.ts",
  "plugins/dsr/examples/react-vite/vite.config.js",
  "plugins/sticky-states/examples/react-vite/vite.config.js",
  "tools/bootstrap-ci-registry-tarballs.mjs",
  "tools/ci-gates-lib.mjs",
  "tools/ci-package-input-lib.mjs",
  "tools/prepare-workspace-browser.mjs",
  "tools/render-ci-workflow.mjs",
  "tools/run-ci-gate.mjs",
  "tools/run-integration-matrix.mjs",
  "tools/run-workspace-browser.mjs",
  "tools/stage-ci-package-artifacts.mjs",
  "tools/test-ci-gates.mjs",
  "tools/test-ci-package-input.mjs",
  "tools/verify-ci-current-waivers.mjs",
  "tools/verify-ci-docs-waivers.mjs",
  "tools/verify-ci-gates.mjs",
  "tools/verify-ci-runtime.mjs",
  "tools/verify-integration-evidence.mjs",
  "tools/verify-package-manager.mjs",
]);
for (const changed of postImplementationPaths)
  if (!changed.startsWith(evidencePrefix) && !c01OwnedPaths.has(changed))
    fail(`change outside I02 evidence and C01 ownership: ${changed}`);
if (
  !evidence.repository.sourceSnapshotSha256 ||
  !/^[a-f0-9]{64}$/.test(evidence.repository.sourceSnapshotSha256)
)
  fail("proof source snapshot is missing");
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
let checkedArtifactArchiveRoot = null;
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
    runLock.contracts.matrixSha256 !== evidence.matrixSha256 ||
    canonicalJson(runLock.repository) !== canonicalJson(evidence.repository)
  )
    fail(`${project.id}: checked run-lock identity differs`);
  const expectedContracts = {
    matrixSha256: evidence.matrixSha256,
    isolatedProjectsSha256: matrix.isolatedProjectsSha256,
    packageArtifactsSha256: matrix.packageArtifactsSha256,
    packageClassificationSha256: matrix.packageClassificationSha256,
    pathRepairsSha256: matrix.pathRepairsSha256,
    baselinesSha256: matrix.baselinesSha256,
    executionLockSha256: matrix.executionLockSha256,
  };
  if (canonicalJson(runLock.contracts) !== canonicalJson(expectedContracts))
    fail(`${project.id}: checked contract chain differs`);
  if (
    runLock.original.fixtureTreeSha256 !== project.fixtureTreeSha256 ||
    runLock.original.manifestPath !== project.manifest ||
    runLock.original.manifestSha256 !== project.committedManifestSha256 ||
    runLock.original.lockPath !== project.committedLock.path ||
    runLock.original.lockSha256 !== project.committedLock.sha256 ||
    sha256File(path.join(repository, project.manifest)) !==
      project.committedManifestSha256 ||
    sha256File(path.join(repository, project.committedLock.path)) !==
      project.committedLock.sha256
  )
    fail(`${project.id}: checked original fixture binding differs`);
  if (
    canonicalJson(runLock.staged.rewriteIds) !==
      canonicalJson(project.rewriteIds) ||
    canonicalJson(runLock.staged.closureBindingIds) !==
      canonicalJson(project.closureBindings.map((binding) => binding.id))
  )
    fail(`${project.id}: checked staged rewrite coverage differs`);
  const expectedSelected = ["npm", "run", project.commands.selected];
  if (
    canonicalJson(runLock.commands.lock) !==
      canonicalJson(matrix.lockPolicy.lockArgv) ||
    canonicalJson(runLock.commands.install) !==
      canonicalJson(matrix.lockPolicy.installArgv) ||
    canonicalJson(runLock.commands.setupBrowser) !==
      canonicalJson(project.browser ? matrix.browser.setupArgv : null) ||
    canonicalJson(runLock.commands.selected) !==
      canonicalJson(expectedSelected) ||
    runLock.commands.selectedSha256 !== sha256(canonicalJson(expectedSelected))
  )
    fail(`${project.id}: checked command policy differs`);
  if (
    runLock.sandbox.outsideRepositoryAncestry !== true ||
    runLock.sandbox.reused !== false ||
    runLock.sandbox.reuseUpdated !== false ||
    runLock.sandbox.changedArtifactIds.length !== 0
  )
    fail(`${project.id}: checked clean sandbox state differs`);
  if (
    Object.hasOwn(runLock.environment, "NODE_PATH") ||
    runLock.environment.npm_config_registry !== matrix.networkPolicy.registry ||
    runLock.environment.npm_config_legacy_peer_deps !== "false" ||
    runLock.environment.npm_config_force !== "false" ||
    runLock.environment.npm_config_offline !== "false" ||
    runLock.environment.npm_config_ignore_scripts !== "true"
  )
    fail(`${project.id}: checked effective npm environment differs`);
  const expectedNpmSettings = {
    registry: matrix.networkPolicy.registry,
    cache: runLock.environment.npm_config_cache,
    "ignore-scripts": "true",
    audit: "false",
    fund: "false",
    "legacy-peer-deps": "false",
    force: "false",
    offline: "false",
    "bin-links": "true",
    ...(project.projectNpmrc?.allowedSettings ?? {}),
  };
  if (
    canonicalJson(runLock.toolchain.projectNpmrc) !==
      canonicalJson(project.projectNpmrc) ||
    canonicalJson(runLock.toolchain.effectiveNpmSettings) !==
      canonicalJson(expectedNpmSettings) ||
    (project.projectNpmrc &&
      sha256File(path.join(repository, project.projectNpmrc.path)) !==
        project.projectNpmrc.sha256)
  )
    fail(`${project.id}: checked npm configuration differs`);
  if (
    runLock.sentinel.package !== matrix.sandboxPolicy.sentinelPackage ||
    runLock.sentinel.preexisting !== false ||
    runLock.sentinel.resolved !== false
  )
    fail(`${project.id}: checked sentinel evidence differs`);
  if (
    canonicalJson(runLock.origins.map((record) => record.edgeId).sort()) !==
      canonicalJson([...project.edgeIds].sort()) ||
    (project.expectedResult === "pass" &&
      runLock.origins.some((record) => record.status !== "verified"))
  )
    fail(`${project.id}: checked logical origins differ`);
  if (project.expectedResult === "pass") {
    if (
      runLock.dependencyGraphs.externalBeforeSha256 !==
        project.externalGraph.sha256 ||
      runLock.dependencyGraphs.externalAfterSha256 !==
        project.expectedExternalGraphSha256 ||
      runLock.dependencyGraphs.lockSha256 !== runLock.staged.lockSha256 ||
      runLock.steps.at(-1).id !== "selected" ||
      runLock.steps.at(-1).status !== 0
    )
      fail(`${project.id}: checked graph/step evidence differs`);
  } else if (
    runLock.steps.at(-1).id !== project.expectedFailure.phase ||
    runLock.steps.at(-1).status === 0 ||
    runLock.sentinel.status !== "not-probed"
  )
    fail(`${project.id}: checked waived-failure phase differs`);
  for (const step of runLock.steps)
    if (
      !Array.isArray(step.argv) ||
      !step.argv.length ||
      !/^[a-f0-9]{64}$/.test(step.stdoutSha256) ||
      !/^[a-f0-9]{64}$/.test(step.stderrSha256)
    )
      fail(`${project.id}: checked step evidence differs ${step.id}`);
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
  const artifactById = new Map(
    runLock.artifacts.map((artifact) => [artifact.artifactId, artifact])
  );
  for (const record of [
    ...runLock.internalPackages,
    ...runLock.origins.filter((origin) => origin.status === "verified"),
  ]) {
    const artifact = artifactById.get(record.artifactId);
    const expectedResolved = `file:${path
      .relative(
        path.join(runLock.sandbox.path, "project"),
        record.stagedArtifactPath
      )
      .split(path.sep)
      .join("/")}`;
    if (
      !artifact ||
      record.lockResolved !== expectedResolved ||
      record.expectedLockResolved !== expectedResolved ||
      record.lockIntegrity !== artifact.integrity ||
      !record.stagedArtifactRealpath.startsWith(
        `${runLock.sandbox.artifactStagingRoot}${path.sep}`
      )
    )
      fail(`${project.id}: checked exact local artifact origin differs`);
  }
  const topLevelInternalIds = runLock.internalPackages
    .filter((record) => record.lockPath === `node_modules/${record.package}`)
    .map((record) => record.artifactId)
    .sort();
  if (project.expectedResult === "pass") {
    if (
      canonicalJson(topLevelInternalIds) !==
        canonicalJson(expectedArtifactIds) ||
      runLock.internalPackages.some(
        (record) => !record.insideSandbox || record.symlink
      ) ||
      runLock.failureBundle !== null ||
      runLock.result.waiver !== null
    )
      fail(`${project.id}: checked internal package provenance differs`);
  } else {
    if (
      !runLock.failureBundle ||
      canonicalJson(runLock.result.waiver) !== canonicalJson(project.waiver) ||
      !project.expectedFailure.contains.every((text) =>
        runLock.result.failureReason.includes(text)
      ) ||
      !result.checkedFailureBundle
    )
      fail(`${project.id}: checked waiver evidence differs`);
    const checkedBundleRoot = safeEvidencePath(
      result.checkedFailureBundle,
      `${project.id} checked failure bundle`
    );
    if (
      !existsSync(checkedBundleRoot) ||
      lstatSync(checkedBundleRoot).isSymbolicLink()
    )
      fail(`${project.id}: checked failure bundle is missing or linked`);
    const checkedRelative = (relative) =>
      ["package.json", "package-lock.json"].includes(path.basename(relative))
        ? `${relative.slice(0, -".json".length)}.evidence.json`
        : relative;
    const names = runLock.failureBundle.contents.map((record) => record.name);
    if (canonicalJson(names) !== canonicalJson(matrix.failureBundleContents))
      fail(`${project.id}: checked failure bundle inventory differs`);
    for (const record of runLock.failureBundle.contents) {
      const absolute = safeEvidencePath(
        checkedRelative(record.path),
        `${project.id} checked failure component ${record.name}`,
        checkedBundleRoot
      );
      if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink())
        fail(
          `${project.id}: checked failure component missing/linked ${record.name}`
        );
      const real = realpathSync(absolute);
      const relation = path.relative(realpathSync(checkedBundleRoot), real);
      if (relation.startsWith("..") || path.isAbsolute(relation))
        fail(`${project.id}: checked failure component escapes ${record.name}`);
      const digest =
        record.name === "artifact-archives"
          ? encodedArchiveDirectorySha256(absolute)
          : statSync(absolute).isDirectory()
          ? directorySha256(absolute)
          : sha256File(absolute);
      if (digest !== record.sha256)
        fail(`${project.id}: checked failure component differs ${record.name}`);
    }
    if (
      sha256(canonicalJson(runLock.failureBundle.contents)) !==
      runLock.failureBundle.sha256
    )
      fail(`${project.id}: checked failure bundle manifest differs`);
    const component = (name) =>
      runLock.failureBundle.contents.find((record) => record.name === name);
    const componentPath = (name) =>
      safeEvidencePath(
        checkedRelative(component(name).path),
        `${project.id} checked ${name}`,
        checkedBundleRoot
      );
    const detached = JSON.parse(
      readFileSync(componentPath("run-lock"), "utf8")
    );
    const expectedDetached = {
      ...runLock,
      bundleState: "detached-pre-manifest",
      failureBundle: null,
    };
    if (canonicalJson(detached) !== canonicalJson(expectedDetached))
      fail(`${project.id}: checked detached failure lock differs`);
    const exactCommand = JSON.parse(
      readFileSync(componentPath("exact-command"), "utf8")
    );
    const lastStep = runLock.steps.at(-1);
    if (
      canonicalJson(exactCommand) !== canonicalJson(lastStep.argv) ||
      component("stdout").sha256 !== lastStep.stdoutSha256 ||
      component("stderr").sha256 !== lastStep.stderrSha256
    )
      fail(`${project.id}: checked failure command/logs differ`);
    checkedArtifactArchiveRoot = componentPath("artifact-archives");
  }
  if (project.browser && project.expectedResult === "pass") {
    if (
      !runLock.browser ||
      runLock.browser.installerIntegrity !==
        matrix.browser.installerIntegrity ||
      runLock.browser.launcherIntegrity !== matrix.browser.launcherIntegrity ||
      runLock.browser.coreIntegrity !== matrix.browser.coreIntegrity ||
      runLock.browser.descriptorSha256 !== matrix.browser.browsersJsonSha256 ||
      runLock.browser.installerDirectorySha256 !==
        matrix.browser.expectedInstallerDirectorySha256 ||
      runLock.browser.launcherDirectorySha256 !==
        matrix.browser.expectedLauncherDirectorySha256 ||
      runLock.browser.coreDirectorySha256 !==
        matrix.browser.expectedCoreDirectorySha256 ||
      canonicalJson(runLock.browser.executableFiles) !==
        canonicalJson(matrix.browser.expectedExecutableFiles) ||
      runLock.browser.portableCacheSha256 !==
        matrix.browser.expectedPortableCacheSha256 ||
      runLock.browser.installRootSha256 !==
        matrix.browser.expectedPortableCacheSha256
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
if (!checkedArtifactArchiveRoot)
  fail("checked proof lacks a retained artifact archive set");
for (const artifact of evidence.artifacts) {
  const archive = safeEvidencePath(
    `${artifact.filename}.json`,
    `${artifact.artifactId} checked archive`,
    checkedArtifactArchiveRoot
  );
  const decoded = existsSync(archive) ? decodeCheckedArchive(archive) : null;
  if (
    !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    !artifact.filename.includes(`-sha256-${artifact.sha256}.tgz`) ||
    artifact.path !== "artifact-hashes.json" ||
    !decoded ||
    lstatSync(archive).isSymbolicLink() ||
    decoded.filename !== artifact.filename ||
    decoded.sha256 !== artifact.sha256
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
