import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-migration-contract.mjs";

export const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const contractPath = "migration/package-artifacts.json";
export const schemaPath = "migration/schemas/package-artifacts.schema.json";

export function fail(message) {
  throw new Error(`PACKAGE_ARTIFACTS_VERIFY_FAILED: ${message}`);
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export async function sha256File(filename) {
  return sha256(await readFile(filename));
}

export function scriptsSha256(manifest) {
  return sha256(JSON.stringify(manifest.scripts || {}));
}

export function artifactStem(packageName, version, digest) {
  return `${packageName
    .replace(/^@/, "")
    .replaceAll("/", "-")}-${version}-sha256-${digest}`;
}

function validateRelativeSourceMapPath(
  packageId,
  filename,
  label,
  value,
  { allowEmpty = false } = {}
) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(
      `${packageId} source map ${filename} has non-string or empty ${label}`
    );
  }
  if (value === "" && allowEmpty) return;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    fail(`${packageId} source map ${filename} has URI ${label} ${value}`);
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    fail(`${packageId} source map ${filename} has absolute ${label} ${value}`);
  }
  if (value.includes("\\") || path.posix.normalize(value) !== value) {
    fail(
      `${packageId} source map ${filename} has non-normalized ${label} ${value}`
    );
  }
}

export function validateSourceMapReferences(packageId, filename, sourceMap) {
  if (!Array.isArray(sourceMap.sources)) {
    fail(`${packageId} source map ${filename} has non-array sources`);
  }
  const sourceRoot = sourceMap.sourceRoot ?? "";
  validateRelativeSourceMapPath(packageId, filename, "sourceRoot", sourceRoot, {
    allowEmpty: true,
  });
  for (const source of sourceMap.sources) {
    validateRelativeSourceMapPath(packageId, filename, "source", source);
    const combined = path.posix.normalize(path.posix.join(sourceRoot, source));
    const checkoutRelative = combined.replace(/^(?:\.\.\/)+/, "");
    if (/^(?:core|frameworks|plugins|tools)\//.test(checkoutRelative)) {
      fail(
        `${packageId} source map ${filename} has checkout-relative source ${source}`
      );
    }
  }
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

export function assertEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(
      `${label} differs\nexpected ${JSON.stringify(
        expected
      )}\nactual   ${JSON.stringify(actual)}`
    );
  }
}

export function assertUnique(records, selector, label) {
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const value = selector(record);
    if (seen.has(value)) fail(`${label} repeats ${value} at index ${index}`);
    seen.add(value);
  }
}

export function composePath(sourcePath, pathRepairs) {
  let current = sourcePath;
  for (
    let iteration = 0;
    iteration <= pathRepairs.moves.length;
    iteration += 1
  ) {
    const nextMove = pathRepairs.moves.find(
      (move) => current === move.from || current.startsWith(`${move.from}/`)
    );
    if (!nextMove) return current;
    current = `${nextMove.to}${current.slice(nextMove.from.length)}`;
  }
  fail(`path repair cycle while composing ${sourcePath}`);
}

function normalizedOutputSet(outputs) {
  return [...new Set(outputs)].sort();
}

function normalizedFilesPolicy(files, allowed) {
  return (files || [])
    .map((entry) => (allowed.includes(`${entry}/**`) ? `${entry}/**` : entry))
    .sort();
}

export function matchesPackPattern(pattern, filename) {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return filename === prefix || filename.startsWith(`${prefix}/`);
  }
  return filename === pattern;
}

export function validatePackedFileList(contract, packageRecord, filenames) {
  assertUnique(
    filenames,
    (filename) => filename,
    `${packageRecord.id} packed files`
  );
  const forbidden = contract.artifactPolicy.forbiddenPatterns.map(
    (pattern) => new RegExp(pattern)
  );
  for (const filename of filenames) {
    if (
      path.posix.isAbsolute(filename) ||
      filename === ".." ||
      filename.startsWith("../") ||
      filename.includes("/../")
    ) {
      fail(`${packageRecord.id} packed path escapes package: ${filename}`);
    }
    if (
      !packageRecord.pack.allowed.some((pattern) =>
        matchesPackPattern(pattern, filename)
      )
    ) {
      fail(`${packageRecord.id} packs undeclared file ${filename}`);
    }
    const rejectedBy = forbidden.find((pattern) => pattern.test(filename));
    if (rejectedBy)
      fail(
        `${packageRecord.id} packs forbidden file ${filename} (${rejectedBy})`
      );
  }
  for (const required of packageRecord.pack.required) {
    if (!filenames.includes(required))
      fail(`${packageRecord.id} is missing required packed file ${required}`);
  }
}

function exportTarget(manifest, specifier, mode) {
  const exportKey =
    specifier === manifest.name
      ? "."
      : `.${specifier.slice(manifest.name.length)}`;
  const exported = manifest.exports?.[exportKey];
  if (exported) {
    if (mode === "require")
      return typeof exported.require === "string"
        ? exported.require
        : exported.require?.default;
    if (mode === "node-import" || mode === "bundler-import") {
      if (typeof exported.import === "string") return exported.import;
      if (exported.import?.default) return exported.import.default;
      if (typeof exported.default === "string") return exported.default;
    }
    if (mode === "types") {
      if (typeof exported.types === "string") return exported.types;
      if (typeof exported.import?.types === "string")
        return exported.import.types;
      if (typeof exported.require?.types === "string")
        return exported.require.types;
    }
  }
  if (specifier !== manifest.name) return undefined;
  if (mode === "require") return manifest.main;
  if (mode === "bundler-import")
    return manifest.module || manifest["jsnext:main"];
  if (mode === "types") return manifest.types || manifest.typings;
  return undefined;
}

function stripDotSlash(value) {
  return typeof value === "string" ? value.replace(/^\.\//, "") : value;
}

function expectedPackScript(root, manifestPath) {
  const from = path.posix.dirname(manifestPath);
  let helper = path.posix.relative(from, "tools/pack-package.mjs");
  if (!helper.startsWith(".")) helper = `./${helper}`;
  return `node ${helper}`;
}

function expectedPublishedEdges(classification, publishedNames) {
  return classification.edges.filter(
    (edge) =>
      publishedNames.has(edge.package) &&
      ["dependencies", "peerDependencies", "optionalDependencies"].includes(
        edge.manifestSection
      ) &&
      classification.manifests.some(
        (manifest) =>
          manifest.published && manifest.path === edge.consumerManifest
      )
  );
}

async function readJsonAt(root, filename) {
  return JSON.parse(await readFile(path.join(root, filename), "utf8"));
}

export async function loadPackageArtifactsContract(root = repository) {
  return readJsonAt(root, contractPath);
}

export async function validatePackageArtifactsContract({
  root = repository,
  contract: suppliedContract,
} = {}) {
  const contract =
    suppliedContract || (await loadPackageArtifactsContract(root));
  await validateJsonSchema(contract, path.join(root, schemaPath));

  const [
    classification,
    pathRepairs,
    sourceAliases,
    turbo,
    turboEvidence,
    rootManifest,
    rootLock,
    gitignore,
  ] = await Promise.all([
    readJsonAt(root, "migration/package-classification.json"),
    readJsonAt(root, "migration/path-repairs.json"),
    readJsonAt(root, "migration/source-aliases.json"),
    readJsonAt(root, "turbo.json"),
    readJsonAt(root, "migration/evidence/s03/turbo-graph.json"),
    readJsonAt(root, "package.json"),
    readJsonAt(root, "package-lock.json"),
    readFile(path.join(root, ".gitignore"), "utf8"),
  ]);

  for (const [field, filename] of [
    ["packageClassificationSha256", "migration/package-classification.json"],
    ["pathRepairsSha256", "migration/path-repairs.json"],
    ["sourceAliasesSha256", "migration/source-aliases.json"],
    ["turboJsonSha256", "turbo.json"],
    ["rootLockSha256", "package-lock.json"],
  ]) {
    const observed = await sha256File(path.join(root, filename));
    if (contract[field] !== observed) fail(`${field} differs from ${filename}`);
  }
  if (
    pathRepairs.packageClassificationSha256 !==
    contract.packageClassificationSha256
  ) {
    fail("path repairs do not bind the classified package graph");
  }
  if (
    sourceAliases.packageClassificationSha256 !==
    contract.packageClassificationSha256
  ) {
    fail("source aliases do not bind the classified package graph");
  }
  if (
    contract.rootLockPredecessorSha256 !== turboEvidence.rootLock.afterSha256
  ) {
    fail("root lock predecessor does not match the reviewed S03 lock");
  }

  const expectedRuntime = {
    node: `v${rootManifest.engines.node}`,
    npm: rootManifest.engines.npm,
    imageDigest:
      "sha256:56ab6ddaab798f0664b18448a1226bfa9e43aefaa90af280ff79d05c350a2ef8",
  };
  assertEqual(contract.runtime, expectedRuntime, "runtime");
  if (rootManifest.packageManager !== `npm@${contract.runtime.npm}`)
    fail("root packageManager differs from P01 runtime");
  if (rootLock.lockfileVersion !== 3)
    fail("root lockfileVersion must remain 3");
  assertEqual(
    contract.normalizedEnvironment,
    {
      CI: "true",
      HUSKY: "0",
      LC_ALL: "C",
      NODE_ENV: "production",
      TZ: "UTC",
    },
    "normalized environment"
  );
  if (!gitignore.split("\n").includes(".artifacts/"))
    fail("root .gitignore does not exclude package artifacts");

  assertEqual(
    turbo.tasks.pack?.dependsOn,
    ["^build", "build"],
    "Turbo pack dependencies"
  );
  assertEqual(
    turbo.tasks.pack?.outputs,
    [".artifacts/packages/**"],
    "Turbo pack outputs"
  );
  if (turbo.tasks.pack?.cache !== false)
    fail("Turbo pack task must remain uncached");

  const published = classification.manifests.filter(
    (manifest) => manifest.published
  );
  if (published.length !== 12)
    fail(
      `independent classification has ${published.length} published packages, expected 12`
    );
  assertUnique(contract.packages, (record) => record.id, "package id");
  assertUnique(contract.packages, (record) => record.package, "package name");
  assertUnique(
    contract.packages,
    (record) => record.manifest,
    "package manifest"
  );
  assertUnique(
    contract.packages.flatMap((record) => record.entrypoints),
    (entry) => entry.id,
    "entrypoint id"
  );

  const recordsBySource = new Map(
    contract.packages.map((record) => [record.sourceManifest, record])
  );
  const expectedSources = published.map((manifest) => manifest.path).sort();
  assertEqual(
    [...recordsBySource.keys()].sort(),
    expectedSources,
    "published source manifest ownership"
  );
  const publishedNames = new Set(
    published.map((manifest) => manifest.finalName)
  );
  const productionEdges = expectedPublishedEdges(
    classification,
    publishedNames
  );
  const expectedEdgeIds = productionEdges.map((edge) => edge.id).sort();
  const contractEdgeIds = contract.packages
    .flatMap((record) => record.internalEdgeIds)
    .sort();
  const consumerDependencies = new Set(
    Object.keys(contract.consumer.dependencies)
  );
  assertUnique(contractEdgeIds, (edgeId) => edgeId, "internal production edge");
  assertEqual(contractEdgeIds, expectedEdgeIds, "internal production edges");

  for (const classified of published) {
    const record = recordsBySource.get(classified.path);
    const currentManifest = composePath(classified.path, pathRepairs);
    if (record.manifest !== currentManifest)
      fail(
        `${record.id} canonical manifest differs: ${record.manifest} != ${currentManifest}`
      );
    const manifestFilename = path.join(root, record.manifest);
    const manifest = await readJsonAt(root, record.manifest);
    if (record.manifestSha256 !== (await sha256File(manifestFilename)))
      fail(`${record.id} manifest digest differs`);
    if (record.scriptsSha256 !== scriptsSha256(manifest))
      fail(`${record.id} scripts digest differs`);
    if (
      record.package !== manifest.name ||
      record.package !== classified.finalName
    )
      fail(`${record.id} package name differs`);
    if (record.version !== manifest.version)
      fail(`${record.id} package version differs`);
    if (manifest.private === true) fail(`${record.id} is unexpectedly private`);
    for (const peer of Object.keys(manifest.peerDependencies || {})) {
      if (!publishedNames.has(peer) && !consumerDependencies.has(peer)) {
        fail(
          `${record.id} external peer ${peer} is absent from packed-consumer dependencies`
        );
      }
    }
    if (manifest.scripts?.pack !== expectedPackScript(root, record.manifest))
      fail(`${record.id} pack script is not the canonical helper path`);

    const turboBuild = turbo.tasks[`${record.package}#build`];
    if (record.build === null) {
      if (record.kind !== "cli" || manifest.scripts?.build || turboBuild)
        fail(`${record.id} null build is not a buildless CLI`);
    } else {
      if (record.kind === "cli" || !manifest.scripts?.build)
        fail(`${record.id} build contract lacks a package build script`);
      if (!turboBuild)
        fail(`${record.id} lacks a package-specific Turbo build contract`);
      assertEqual(
        normalizedOutputSet(record.build.outputs),
        normalizedOutputSet(turboBuild.outputs),
        `${record.id} build outputs`
      );
      const outputRoots = record.build.outputs
        .map((output) => output.replace(/\/\*\*$/, ""))
        .sort();
      if (
        !record.build.cleanPaths.every((cleanPath) =>
          outputRoots.includes(cleanPath)
        )
      ) {
        fail(`${record.id} clean paths are not all declared build outputs`);
      }
    }

    if (record.kind === "angular-library") {
      if (record.pack.directory !== "dist")
        fail(`${record.id} Angular pack directory must be dist`);
      const expectedStem = `uirouter-${record.package.slice(
        "@uirouter/".length
      )}`;
      const expectedModule = `fesm2022/${expectedStem}.mjs`;
      const expectedTypes = `types/${expectedStem}.d.ts`;
      if (
        !record.pack.required.includes(expectedModule) ||
        !record.pack.required.includes(expectedTypes)
      ) {
        fail(`${record.id} does not require generated ng-packagr entrypoints`);
      }
      if (record.id === "angular") {
        if (
          manifest.module !== `dist/${expectedModule}` ||
          manifest.typings !== `dist/${expectedTypes}`
        ) {
          fail(
            "Angular workspace manifest does not expose its built dist entrypoints"
          );
        }
      }
    } else {
      if (record.pack.directory !== ".")
        fail(`${record.id} non-Angular pack directory must be package root`);
      const expectedFiles = record.pack.allowed.filter(
        (entry) => !["package.json", "README.md", "LICENSE"].includes(entry)
      );
      assertEqual(
        normalizedFilesPolicy(manifest.files, expectedFiles),
        [...expectedFiles].sort(),
        `${record.id} manifest files policy`
      );
    }

    for (const entrypoint of record.entrypoints) {
      if (!record.pack.required.includes(entrypoint.target))
        fail(`${entrypoint.id} target is not required by the pack contract`);
      if (
        !record.pack.allowed.some((pattern) =>
          matchesPackPattern(pattern, entrypoint.target)
        )
      ) {
        fail(`${entrypoint.id} target is not allowed by the pack contract`);
      }
      if (entrypoint.mode === "bin") {
        if (
          record.kind !== "cli" ||
          stripDotSlash(manifest.bin?.[entrypoint.specifier]) !==
            entrypoint.target
        ) {
          fail(`${entrypoint.id} bin target differs from the manifest`);
        }
      } else if (record.kind !== "angular-library") {
        const declaredTarget = stripDotSlash(
          exportTarget(manifest, entrypoint.specifier, entrypoint.mode)
        );
        if (declaredTarget !== entrypoint.target) {
          fail(
            `${entrypoint.id} target differs from manifest entrypoint: ${declaredTarget}`
          );
        }
      }
    }

    const ownedEdges = productionEdges.filter(
      (edge) => edge.consumerManifest === classified.path
    );
    assertEqual(
      record.internalEdgeIds.slice().sort(),
      ownedEdges.map((edge) => edge.id).sort(),
      `${record.id} production edge ownership`
    );
    for (const edge of ownedEdges) {
      if (edge.packedExpectation !== "local-tarball")
        fail(`${edge.id} is not classified for a local tarball`);
      const declared = manifest[edge.manifestSection]?.[edge.package];
      if (declared !== edge.finalSpec)
        fail(
          `${edge.id} manifest spec differs: ${declared} != ${edge.finalSpec}`
        );
    }
  }

  const cliRecord = contract.packages.find((record) => record.kind === "cli");
  if (
    !cliRecord ||
    cliRecord.package !== "@uirouter/publish-scripts" ||
    cliRecord.entrypoints.length !== 10
  ) {
    fail("Publish Scripts must be the single ten-bin CLI package");
  }
  if (
    contract.packages.filter((record) => record.kind === "angular-library")
      .length !== 2
  ) {
    fail("exactly two generated Angular package records are required");
  }
  if (
    contract.packages.filter((record) => record.build !== null).length !== 11
  ) {
    fail("exactly eleven published packages must own production builds");
  }
  if (
    contract.artifactPolicy.repetitions !== 2 ||
    contract.artifactPolicy.waivers.length !== 0
  ) {
    fail("P01 requires two deterministic runs with no nondeterminism waivers");
  }
  for (const pattern of contract.artifactPolicy.forbiddenPatterns) {
    try {
      new RegExp(pattern);
    } catch {
      fail(`invalid forbidden archive pattern ${pattern}`);
    }
  }
  if (
    !contract.consumer.lockArgv.includes("--package-lock-only") ||
    !contract.consumer.lockArgv.includes("--ignore-scripts")
  ) {
    fail("consumer lock command must be lock-only with scripts disabled");
  }
  if (
    !contract.consumer.installArgv.includes("ci") ||
    !contract.consumer.installArgv.includes("--ignore-scripts")
  ) {
    fail("consumer install command must use npm ci with scripts disabled");
  }
  if (
    contract.consumer.dependencies["react"] !== "19.2.8" ||
    contract.consumer.dependencies["@types/react"] !== "19.2.18"
  ) {
    fail("packed consumer must use one exact React 19 runtime/type line");
  }

  return { contract, classification, pathRepairs, productionEdges, turbo };
}

export async function validatePackageArtifactsEvidence({
  root = repository,
  contract: suppliedContract,
} = {}) {
  const contract =
    suppliedContract || (await loadPackageArtifactsContract(root));
  const consumerLockPath = path.join(
    root,
    "migration/evidence/p01/consumer-package-lock.json"
  );
  const [evidence, consumerLock] = await Promise.all([
    readJsonAt(root, "migration/evidence/p01/package-proof.json"),
    readJsonAt(root, "migration/evidence/p01/consumer-package-lock.json"),
  ]);
  if (
    evidence.schemaVersion !== 1 ||
    evidence.task !== "P01" ||
    evidence.owner !== "ui-router-maintainers"
  ) {
    fail("package proof identity differs");
  }
  if (
    evidence.contractSha256 !==
    (await sha256File(path.join(root, contractPath)))
  )
    fail("package proof contract digest differs");
  if (evidence.rootLockSha256 !== contract.rootLockSha256)
    fail("package proof root lock digest differs");
  assertEqual(evidence.runtime, contract.runtime, "package proof runtime");
  assertEqual(
    evidence.normalizedEnvironment,
    contract.normalizedEnvironment,
    "package proof environment"
  );
  if (
    evidence.repetitions !== contract.artifactPolicy.repetitions ||
    evidence.builds?.identical !== true ||
    !Number.isInteger(evidence.builds?.fileCount) ||
    evidence.builds.fileCount < 1 ||
    !/^[0-9a-f]{64}$/.test(evidence.builds?.sha256 || "")
  ) {
    fail("package proof deterministic build record differs");
  }
  if (
    evidence.productionEdges !==
    contract.packages.flatMap((record) => record.internalEdgeIds).length
  ) {
    fail("package proof production edge count differs");
  }
  assertUnique(
    evidence.packages || [],
    (record) => record.artifactId,
    "package proof artifact id"
  );
  const expectedIds = contract.packages.map((record) => record.id).sort();
  assertEqual(
    (evidence.packages || []).map((record) => record.artifactId).sort(),
    expectedIds,
    "package proof artifacts"
  );
  const artifactByPackage = new Map(
    evidence.packages.map((record) => [record.package, record])
  );
  for (const record of contract.packages) {
    const artifact = artifactByPackage.get(record.package);
    if (
      !artifact ||
      artifact.artifactId !== record.id ||
      artifact.version !== record.version
    ) {
      fail(`${record.id} package proof identity differs`);
    }
    for (const field of ["sha256", "filesSha256"]) {
      if (!/^[0-9a-f]{64}$/.test(artifact[field] || ""))
        fail(`${record.id} package proof ${field} is invalid`);
    }
    const expectedFilename = `${artifactStem(
      record.package,
      record.version,
      artifact.sha256
    )}.tgz`;
    if (
      artifact.filename !== expectedFilename ||
      path.posix.basename(artifact.filename) !== artifact.filename
    ) {
      fail(
        `${record.id} package proof filename is not the exact content-addressed basename`
      );
    }
    if (
      !Number.isInteger(artifact.fileCount) ||
      artifact.fileCount < 1 ||
      !Number.isInteger(artifact.size) ||
      artifact.size < 1
    ) {
      fail(`${record.id} package proof size/count is invalid`);
    }
    const lockRecord =
      consumerLock.packages?.[`node_modules/${record.package}`];
    if (
      !lockRecord ||
      lockRecord.version !== record.version ||
      lockRecord.integrity !== artifact.integrity ||
      String(lockRecord.resolved || "") !==
        `file:../artifacts/${artifact.filename}`
    ) {
      fail(
        `${record.id} consumer evidence does not bind its local content-addressed tarball`
      );
    }
  }
  if (evidence.consumer?.lockSha256 !== (await sha256File(consumerLockPath)))
    fail("package proof consumer lock digest differs");
  const expectedEntrypoints = contract.packages.reduce(
    (count, record) => count + record.entrypoints.length,
    0
  );
  const expectedModes = Object.fromEntries(
    ["require", "node-import", "bundler-import", "types", "bin"].map((mode) => [
      mode,
      contract.packages
        .flatMap((record) => record.entrypoints)
        .filter((entrypoint) => entrypoint.mode === mode).length,
    ])
  );
  if (
    evidence.consumer.internalPackages !== contract.packages.length ||
    evidence.consumer.entrypoints !== expectedEntrypoints ||
    evidence.consumer.requireProbes !== expectedModes.require ||
    evidence.consumer.nodeImportProbes !== expectedModes["node-import"] ||
    evidence.consumer.bundlerProbes !== expectedModes["bundler-import"] ||
    evidence.consumer.typeProbes !== expectedModes.types ||
    evidence.consumer.binProbes !== expectedModes.bin ||
    evidence.consumer.sentinelRejected !== true
  ) {
    fail("package proof consumer probe counts differ");
  }
  if (evidence.waivers?.length !== 0)
    fail("package proof must not contain waivers");
  return { evidence, consumerLock };
}

export async function packageRecordForCwd(cwd, root = repository) {
  const { contract } = await validatePackageArtifactsContract({ root });
  const realCwd = await realpath(cwd);
  for (const record of contract.packages) {
    const packageRoot = path.join(root, path.posix.dirname(record.manifest));
    if ((await realpath(packageRoot)) === realCwd)
      return { contract, packageRecord: record, packageRoot };
  }
  fail(`current directory is not a contracted published package: ${cwd}`);
}
