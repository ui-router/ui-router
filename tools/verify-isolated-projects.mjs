#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { validateJsonSchema } from "./validate-migration-contract.mjs";
import {
  hasGitRepository,
  I01_BASE_COMMIT,
  verifyI01GitClosure,
} from "./i01-scope-lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const root = realpathSync(
  path.resolve(argument("--root") ?? path.join(import.meta.dirname, ".."))
);
const fail = (message) => {
  throw new Error(`ISOLATED_PROJECTS_VERIFY_FAILED: ${message}`);
};
const testFixtureWithoutGit = process.argv.includes("--test-fixture-no-git");
const gitAvailable = hasGitRepository(root);
if (testFixtureWithoutGit) {
  const temporaryRoot = realpathSync(tmpdir());
  const validFixture =
    process.env.I01_TEST_FIXTURE === "1" &&
    !gitAvailable &&
    root.startsWith(`${temporaryRoot}${path.sep}`) &&
    path.basename(root).startsWith("uirouter-i01-");
  if (!validFixture) {
    fail("--test-fixture-no-git is restricted to the adversarial temp fixture");
  }
} else if (!gitAvailable) {
  fail("Git repository required for I01 change-closure verification");
} else {
  try {
    verifyI01GitClosure(root);
  } catch (error) {
    fail(`Git change closure: ${error.message}`);
  }
}
const readText = (relative) => readFileSync(path.join(root, relative), "utf8");
const readJson = (relative) => JSON.parse(readText(relative));
const sha256 = (relative) =>
  createHash("sha256")
    .update(readFileSync(path.join(root, relative)))
    .digest("hex");
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const valueSha256 = (value) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const expectEqual = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected))
    fail(
      `${label} mismatch: expected ${canonicalJson(
        expected
      )}, got ${canonicalJson(actual)}`
    );
};

const contract = readJson("migration/isolated-projects.json");
const classification = readJson("migration/package-classification.json");
const repairs = readJson("migration/path-repairs.json");
const baselines = readJson("migration/baselines.json");
const sources = readJson("migration/sources.json");
const inventory = readJson("migration/evidence/control/n00/inventory.json");
try {
  await validateJsonSchema(
    contract,
    path.join(root, "migration/schemas/isolated-projects.schema.json")
  );
} catch (error) {
  fail(`schema: ${error.message}`);
}
for (const [field, file] of [
  ["packageClassificationSha256", "migration/package-classification.json"],
  ["pathRepairsSha256", "migration/path-repairs.json"],
  ["baselinesSha256", "migration/baselines.json"],
  ["executionLockSha256", "migration/execution-lock.json"],
]) {
  const actual = sha256(file);
  if (contract[field] !== actual)
    fail(
      `${field} digest mismatch: expected ${actual}, got ${contract[field]}`
    );
}

function canonicalize(input) {
  let current = input;
  const seen = new Set([current]);
  for (const move of repairs.moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) {
      current = `${move.to}${current.slice(move.from.length)}`;
      if (seen.has(current))
        fail(`path-repair cycle while canonicalizing ${input}: ${current}`);
      seen.add(current);
    }
  }
  return current;
}

const integrationRecords = classification.manifests
  .filter((record) => record.class === "integration")
  .sort((left, right) => left.id.localeCompare(right.id));
const byCanonicalPath = new Map(
  classification.manifests.map((record) => [canonicalize(record.path), record])
);
const byName = new Map();
for (const record of classification.manifests) {
  const manifest = readJson(canonicalize(record.path));
  if (byName.has(manifest.name))
    fail(`duplicate current manifest name: ${manifest.name}`);
  byName.set(manifest.name, {
    record,
    manifest,
    path: canonicalize(record.path),
  });
}

const expectedWorkspaceGlobs = [
  "core",
  "plugins/*",
  "plugins/*/examples/*",
  "frameworks/*/uirouter-*",
  "frameworks/*/examples/*",
  "tools/*",
];
const rootPackage = readJson("package.json");
expectEqual(
  rootPackage.workspaces,
  expectedWorkspaceGlobs,
  "root workspace globs"
);
function expandWorkspacePattern(pattern) {
  const segments = pattern.split("/");
  let candidates = [""];
  for (const segment of segments) {
    const next = [];
    for (const candidate of candidates) {
      const directory = path.join(root, candidate);
      if (segment.includes("*")) {
        if (!existsSync(directory)) continue;
        const matcher = new RegExp(
          `^${segment
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`
        );
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            matcher.test(entry.name)
          )
            next.push(path.posix.join(candidate, entry.name));
        }
      } else {
        const relative = path.posix.join(candidate, segment);
        if (
          existsSync(path.join(root, relative)) &&
          statSync(path.join(root, relative)).isDirectory()
        )
          next.push(relative);
      }
    }
    candidates = next;
  }
  return candidates
    .filter((directory) =>
      existsSync(path.join(root, directory, "package.json"))
    )
    .map((directory) => `${directory}/package.json`);
}
const expandedWorkspaces = [
  ...new Set(rootPackage.workspaces.flatMap(expandWorkspacePattern)),
].sort();
const classifiedWorkspaces = classification.manifests
  .filter((record) => record.workspace)
  .map((record) => canonicalize(record.path))
  .sort();
expectEqual(
  expandedWorkspaces,
  classifiedWorkspaces,
  "expanded root workspace inventory"
);

const ordinaryExamples = classification.manifests.filter(
  (record) => record.class === "example"
);
for (const record of ordinaryExamples) {
  const manifestPath = canonicalize(record.path);
  const manifest = readJson(manifestPath);
  if (
    !record.workspace ||
    record.lockOwner !== "root" ||
    !expandedWorkspaces.includes(manifestPath)
  )
    fail(`${record.id}: ordinary example must remain a root workspace`);
  if (manifest.private !== true)
    fail(`${record.id}: ordinary example must remain private`);
  if (
    existsSync(
      path.join(root, path.posix.dirname(manifestPath), "package-lock.json")
    )
  )
    fail(`${record.id}: ordinary example must not own a local lock`);
}

function discoverIntegrationManifests(directory, output = []) {
  if (!existsSync(directory)) return output;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      ["node_modules", "dist", "coverage", ".cache", ".turbo"].includes(
        entry.name
      )
    )
      continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      fail(
        `symbolic link in isolated project tree: ${path.relative(
          root,
          absolute
        )}`
      );
    if (entry.isDirectory()) discoverIntegrationManifests(absolute, output);
    else if (entry.name === "package.json")
      output.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return output;
}
const integrationRoots = [
  ...new Set(
    integrationRecords.map((record) => {
      const current = canonicalize(record.path);
      return current.slice(
        0,
        current.indexOf("/integration-tests/") + "/integration-tests".length
      );
    })
  ),
].sort();
const discoveredIntegrations = integrationRoots
  .flatMap((relative) =>
    discoverIntegrationManifests(path.join(root, relative))
  )
  .sort();
const classifiedIntegrations = integrationRecords
  .map((record) => canonicalize(record.path))
  .sort();
expectEqual(
  discoveredIntegrations,
  classifiedIntegrations,
  "isolated manifest inventory"
);
for (const manifest of classifiedIntegrations)
  if (expandedWorkspaces.includes(manifest))
    fail(`${manifest}: isolated project entered the root workspaces`);

const slug = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const legacyId = (manifest, packageName, key) =>
  `edge-${slug(
    manifest.replace(/\/package\.json$/, "")
  )}-legacy-injected-${slug(packageName)}-${slug(key)}`;
function downstreamEntries(value, prefix = []) {
  const result = [];
  for (const [key, item] of Object.entries(value)) {
    if (key === "packageDir") continue;
    if (
      key === "projects" &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      result.push(...downstreamEntries(item));
    } else if (typeof item === "string") {
      result.push({
        key: (prefix.length ? [...prefix, key] : ["default", key]).join("."),
        destination: item,
      });
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      result.push(...downstreamEntries(item, [...prefix, key]));
    } else {
      fail(`invalid downstream configuration at ${[...prefix, key].join(".")}`);
    }
  }
  return result;
}

const sourceContracts = new Map(
  sources.sources.map((source) => [source.name, source])
);
const sourceDestinationMap = new Map();
for (const source of sources.sources) {
  const url = source.url.replace(/\/$/, "");
  const repositoryName = new URL(url).pathname
    .split("/")
    .pop()
    .replace(/\.git$/, "");
  if (repositoryName === source.name)
    sourceDestinationMap.set(url, canonicalize(source.destinationPrefix));
}
const currentLegacyIds = new Set();
for (const source of inventory.sources) {
  if (source.downstreamProjects === null) continue;
  const rootSnapshot = source.manifests.find(
    (snapshot) => snapshot.sourcePath === "package.json"
  );
  if (!rootSnapshot)
    fail(`${source.name}: downstream owner lacks a root manifest`);
  const configPath = `${path.posix.dirname(
    canonicalize(rootSnapshot.finalPath)
  )}/downstream_projects.json`;
  if (!existsSync(path.join(root, configPath)))
    fail(`${source.name}: downstream config missing at ${configPath}`);
  const producer = byCanonicalPath.get(
    `${path.posix.dirname(configPath)}/package.json`
  );
  const producerManifest = producer && readJson(canonicalize(producer.path));
  if (!producerManifest)
    fail(`${source.name}: downstream producer is not classified`);
  for (const entry of downstreamEntries(readJson(configPath))) {
    let consumerDirectory;
    if (/^https?:\/\//.test(entry.destination)) {
      consumerDirectory = sourceDestinationMap.get(
        entry.destination.replace(/\/$/, "")
      );
      const allowedAlias =
        source.name === "core" &&
        entry.key === "angularjs.angularjs" &&
        entry.destination === "https://github.com/angular-ui/ui-router.git";
      if (!consumerDirectory && allowedAlias) continue;
      if (!consumerDirectory)
        fail(`${configPath}:${entry.key}: unmapped downstream repository`);
    } else {
      consumerDirectory = path.posix.normalize(
        path.posix.join(path.posix.dirname(configPath), entry.destination)
      );
    }
    const consumer = byCanonicalPath.get(`${consumerDirectory}/package.json`);
    if (!consumer)
      fail(
        `${configPath}:${entry.key}: downstream destination is not classified`
      );
    currentLegacyIds.add(
      legacyId(consumer.path, producerManifest.name, entry.key)
    );
  }
}

const sourceSnapshotsByImportedPath = new Map();
for (const source of inventory.sources)
  for (const snapshot of source.manifests)
    sourceSnapshotsByImportedPath.set(snapshot.importedPath, {
      source,
      snapshot,
    });
const baselineLegacyRaw = new Map();
for (const source of inventory.sources) {
  if (source.downstreamProjects === null) continue;
  const producer = source.manifests.find(
    (snapshot) => snapshot.sourcePath === "package.json"
  );
  const sourceContract = sourceContracts.get(source.name);
  for (const entry of downstreamEntries(source.downstreamProjects)) {
    if (/^https?:\/\//.test(entry.destination)) continue;
    const importedManifest = path.posix.normalize(
      path.posix.join(
        sourceContract.destinationPrefix,
        entry.destination,
        "package.json"
      )
    );
    const consumerSnapshot =
      sourceSnapshotsByImportedPath.get(importedManifest)?.snapshot;
    if (!consumerSnapshot) continue;
    const consumer = classification.manifests.find(
      (record) => record.path === consumerSnapshot.finalPath
    );
    if (!consumer) continue;
    baselineLegacyRaw.set(
      legacyId(consumer.path, producer.name, entry.key),
      `yalc:${producer.name}->${entry.destination}`
    );
  }
}

const baselineById = new Map();
for (const entry of baselines.entries) {
  if (baselineById.has(entry.id)) fail(`duplicate baseline id: ${entry.id}`);
  baselineById.set(entry.id, entry);
}
const contractById = new Map();
for (const project of contract.projects) {
  if (contractById.has(project.id))
    fail(`duplicate contract project id: ${project.id}`);
  contractById.set(project.id, project);
}
expectEqual(
  [...contractById.keys()].sort(),
  integrationRecords.map((record) => record.id),
  "contract project ids"
);
expectEqual(
  contract.projects.map((project) => project.id),
  integrationRecords.map((record) => record.id),
  "contract project order"
);

const derivedProjects = [];
for (const record of integrationRecords) {
  const project = contractById.get(record.id);
  const manifestPath = canonicalize(record.path);
  if (manifestPath === record.path)
    fail(`${record.id}: isolated path has no declared path repair`);
  if (existsSync(path.join(root, record.path)))
    fail(
      `${record.id}: stale pre-repair manifest still exists at ${record.path}`
    );
  if (!existsSync(path.join(root, manifestPath)))
    fail(`${record.id}: canonical manifest is missing at ${manifestPath}`);
  const manifest = readJson(manifestPath);
  if (
    record.workspace ||
    record.published ||
    !["local", "none"].includes(record.lockOwner)
  )
    fail(`${record.id}: invalid isolated classification ownership`);
  if (manifest.private !== true || manifest.name !== record.finalName)
    fail(`${record.id}: current manifest identity differs from classification`);
  if (
    !manifest.scripts ||
    typeof manifest.scripts.test !== "string" ||
    manifest.scripts.test.length === 0
  )
    fail(`${record.id}: test command is missing`);
  const hasE2e =
    typeof manifest.scripts.e2e === "string" && manifest.scripts.e2e.length > 0;
  const hasSetupBrowser =
    typeof manifest.scripts["setup:browser"] === "string" &&
    manifest.scripts["setup:browser"].length > 0;
  if (hasE2e !== hasSetupBrowser)
    fail(`${record.id}: e2e and setup:browser must remain paired`);
  const mode = record.lockOwner === "local" ? "runnable" : "template";
  if (mode === "runnable" && record.internalResolutionMode !== "local-tarball")
    fail(`${record.id}: runnable project must use local-tarball resolution`);
  if (mode === "template" && record.internalResolutionMode !== "none")
    fail(`${record.id}: template must use no internal resolution mode`);

  const projectEdges = classification.edges
    .filter((edge) => edge.consumerManifest === record.path)
    .sort((left, right) => left.id.localeCompare(right.id));
  const declaredEdges = projectEdges.filter(
    (edge) => edge.declaredSpec !== null
  );
  const legacyEdges = projectEdges.filter((edge) => edge.declaredSpec === null);
  for (const edge of projectEdges) {
    if (
      edge.resolutionMode !== "local-tarball" ||
      edge.packedExpectation !== "local-tarball" ||
      edge.owningLane !== record.owningLane
    )
      fail(`${edge.id}: isolated edge policy mismatch`);
    if (edge.declaredSpec === null) {
      if (edge.manifestSection !== "legacy-injected")
        fail(`${edge.id}: null declaredSpec is not legacy-injected`);
    } else if (
      manifest[edge.manifestSection]?.[edge.package] !== edge.declaredSpec
    ) {
      fail(
        `${edge.id}: committed manifest no longer retains source spec ${edge.declaredSpec}`
      );
    }
  }
  if (mode === "runnable" && legacyEdges.length !== 1)
    fail(
      `${record.id}: runnable project must own exactly one legacy-injected edge`
    );
  if (mode === "template" && legacyEdges.length !== 0)
    fail(`${record.id}: template must not own a legacy-injected edge`);
  for (const edge of legacyEdges)
    if (!currentLegacyIds.has(edge.id))
      fail(
        `${edge.id}: current downstream configuration no longer derives the classified relation`
      );

  const snapshotMatches = [];
  for (const source of inventory.sources)
    for (const snapshot of source.manifests)
      if (snapshot.finalPath === record.path)
        snapshotMatches.push({ source, snapshot });
  if (snapshotMatches.length !== 1)
    fail(
      `${record.id}: expected one source snapshot, found ${snapshotMatches.length}`
    );
  const [{ source, snapshot }] = snapshotMatches;
  const baselineSourcePath =
    snapshot.sourcePath === "package.json"
      ? "."
      : path.posix.dirname(snapshot.sourcePath);
  const manifestBaselines = baselines.entries.filter(
    (entry) =>
      entry.source === source.name &&
      entry.sourcePath === baselineSourcePath &&
      entry.lane === "static"
  );
  if (manifestBaselines.length !== 1 || manifestBaselines[0].result !== "pass")
    fail(`${record.id}: source-manifest baseline is missing or non-passing`);

  let downstreamBaselineIds = [];
  let downstreamDiscoveryBaselineId = null;
  if (mode === "runnable") {
    const raw = baselineLegacyRaw.get(legacyEdges[0].id);
    if (!raw)
      fail(`${legacyEdges[0].id}: source-era downstream relation is missing`);
    const matches = baselines.entries
      .filter((entry) => entry.legacyInjectedEdges?.includes(raw))
      .sort((left, right) => left.id.localeCompare(right.id));
    const discoveries = matches.filter(
      (entry) => entry.downstreamProject !== null && entry.lane === "static"
    );
    if (discoveries.length !== 1 || discoveries[0].result !== "pass")
      fail(`${record.id}: expected one passing downstream-discovery baseline`);
    if (!matches.some((entry) => entry.lane === "downstream"))
      fail(`${record.id}: aggregate downstream baseline is missing`);
    downstreamBaselineIds = matches.map((entry) => entry.id);
    downstreamDiscoveryBaselineId = discoveries[0].id;
  }

  let lock = null;
  let generatorScript = null;
  const registryBaselineRecords = [];
  if (mode === "runnable") {
    const lockPath = `${path.posix.dirname(manifestPath)}/package-lock.json`;
    if (
      !existsSync(path.join(root, lockPath)) ||
      lstatSync(path.join(root, lockPath)).isSymbolicLink()
    )
      fail(`${record.id}: local lock is missing or symbolic`);
    const lockValue = readJson(lockPath);
    if (
      lockValue.lockfileVersion !== 3 ||
      !lockValue.packages ||
      !lockValue.packages[""]
    )
      fail(
        `${record.id}: local lock must be lockfileVersion 3 with a root package`
      );
    if (
      lockValue.packages[""].name !== manifest.name ||
      lockValue.packages[""].version !== manifest.version
    )
      fail(`${record.id}: local lock root identity differs from the manifest`);
    lock = {
      path: lockPath,
      sha256: sha256(lockPath),
      packageEntries: Object.keys(lockValue.packages).length,
    };
    for (const edge of declaredEdges) {
      const item = lockValue.packages[`node_modules/${edge.package}`];
      if (
        !item ||
        item.link === true ||
        typeof item.version !== "string" ||
        typeof item.resolved !== "string" ||
        typeof item.integrity !== "string"
      )
        fail(
          `${edge.id}: direct registry baseline is missing from the committed lock`
        );
      if (
        !item.resolved.startsWith("https://registry.npmjs.org/") ||
        !item.integrity.startsWith("sha512-")
      )
        fail(
          `${edge.id}: committed lock does not preserve an integrity-bound npm registry baseline`
        );
      if (item.version !== edge.expectedVersion)
        fail(
          `${edge.id}: registry baseline version ${item.version} differs from ${edge.expectedVersion}`
        );
      if (
        lockValue.packages[""][edge.manifestSection]?.[edge.package] !==
        manifest[edge.manifestSection]?.[edge.package]
      )
        fail(`${edge.id}: lock root spec differs from the committed manifest`);
      registryBaselineRecords.push({
        edgeId: edge.id,
        package: edge.package,
        version: item.version,
        resolved: item.resolved,
        integrity: item.integrity,
      });
    }
    const declaredPackages = new Set(declaredEdges.map((edge) => edge.package));
    for (const edge of legacyEdges) {
      if (
        !declaredPackages.has(edge.package) &&
        lockValue.packages[`node_modules/${edge.package}`]
      )
        fail(
          `${edge.id}: legacy-only dependency leaked into the committed registry baseline lock`
        );
    }
  } else {
    const lockPath = `${path.posix.dirname(manifestPath)}/package-lock.json`;
    if (existsSync(path.join(root, lockPath)))
      fail(`${record.id}: generator template must not own a lock`);
    const parent = path.posix.dirname(path.posix.dirname(manifestPath));
    const generators = readdirSync(path.join(root, parent))
      .filter((name) => name.endsWith(".sh"))
      .sort();
    if (generators.length !== 1)
      fail(
        `${record.id}: expected exactly one owning generator script, found ${generators.length}`
      );
    generatorScript = `${parent}/${generators[0]}`;
    if ((statSync(path.join(root, generatorScript)).mode & 0o111) === 0)
      fail(`${record.id}: generator script is not executable`);
  }

  const derived = {
    id: record.id,
    sourceManifest: record.path,
    manifest: manifestPath,
    mode,
    name: manifest.name,
    manifestSha256: sha256(manifestPath),
    scriptsSha256: valueSha256(manifest.scripts),
    commands: {
      test: "test",
      e2e: hasE2e ? "e2e" : null,
      setupBrowser: hasSetupBrowser ? "setup:browser" : null,
    },
    lock,
    generatorScript,
    manifestBaselineId: manifestBaselines[0].id,
    downstreamDiscoveryBaselineId,
    downstreamBaselineIds,
    internalEdgeIds: projectEdges.map((edge) => edge.id),
    declaredEdgeIds: declaredEdges.map((edge) => edge.id),
    legacyInjectedEdgeIds: legacyEdges.map((edge) => edge.id),
    registryBaselineRecords,
  };
  for (const key of Object.keys(derived))
    expectEqual(project[key], derived[key], `${record.id} ${key}`);
  derivedProjects.push(derived);
}

const projectEdgeIds = new Set(
  derivedProjects.flatMap((project) => project.internalEdgeIds)
);
const classifiedLocalTarballs = classification.edges
  .filter((edge) => edge.resolutionMode === "local-tarball")
  .map((edge) => edge.id)
  .sort();
expectEqual(
  [...projectEdgeIds].sort(),
  classifiedLocalTarballs,
  "isolated local-tarball edge inventory"
);
const derivedCounts = {
  projects: derivedProjects.length,
  runnable: derivedProjects.filter((project) => project.mode === "runnable")
    .length,
  templates: derivedProjects.filter((project) => project.mode === "template")
    .length,
  localLocks: derivedProjects.filter((project) => project.lock !== null).length,
  browserProjects: derivedProjects.filter(
    (project) => project.commands.setupBrowser !== null
  ).length,
  internalEdges: derivedProjects.reduce(
    (sum, project) => sum + project.internalEdgeIds.length,
    0
  ),
  declaredEdges: derivedProjects.reduce(
    (sum, project) => sum + project.declaredEdgeIds.length,
    0
  ),
  legacyInjectedEdges: derivedProjects.reduce(
    (sum, project) => sum + project.legacyInjectedEdgeIds.length,
    0
  ),
  registryBaselineRecords: derivedProjects.reduce(
    (sum, project) => sum + project.registryBaselineRecords.length,
    0
  ),
  ordinaryExamples: ordinaryExamples.length,
};
expectEqual(contract.counts, derivedCounts, "isolated project counts");

const evidence = readJson("migration/evidence/i01/isolation-proof.json");
const installProofPath = "migration/evidence/i01/install-proof.json";
const approvedInstallProofSha256 =
  "f605eae4bd070bc9b4e5ca5a48f96faff20b81aa9016e592d8762c85bc2cda94";
if (sha256(installProofPath) !== approvedInstallProofSha256) {
  fail(
    `approved install proof digest mismatch: expected ${approvedInstallProofSha256}, got ${sha256(
      installProofPath
    )}`
  );
}
const installProof = readJson(installProofPath);
expectEqual(evidence.schemaVersion, 1, "I01 evidence schema version");
expectEqual(evidence.task, "I01", "I01 evidence task");
expectEqual(evidence.owner, "ui-router-maintainers", "I01 evidence owner");
expectEqual(evidence.baseCommit, I01_BASE_COMMIT, "I01 evidence base");
const expectedRuntime = {
  node: "v24.19.0",
  npm: "11.17.0",
  imageDigest:
    "sha256:56ab6ddaab798f0664b18448a1226bfa9e43aefaa90af280ff79d05c350a2ef8",
};
expectEqual(evidence.runtime, expectedRuntime, "I01 evidence runtime");
expectEqual(
  evidence.contract,
  {
    path: "migration/isolated-projects.json",
    sha256: sha256("migration/isolated-projects.json"),
  },
  "I01 evidence contract"
);
expectEqual(
  evidence.implementation,
  {
    schemaSha256: sha256("migration/schemas/isolated-projects.schema.json"),
    scopeVerifierSha256: sha256("tools/i01-scope-lib.mjs"),
    installProofToolSha256: sha256("tools/prove-npm-installs.mjs"),
    verifierSha256: sha256("tools/verify-isolated-projects.mjs"),
    adversarialTestSha256: sha256("tools/test-isolated-projects.mjs"),
  },
  "I01 evidence implementation"
);
expectEqual(
  rootPackage.scripts?.["prove:isolated-installs"],
  "node tools/prove-npm-installs.mjs --expected migration/evidence/i01/install-proof.json",
  "I01 reproducible install-proof command"
);
expectEqual(evidence.counts, derivedCounts, "I01 evidence counts");
expectEqual(
  evidence.sourceChanges,
  {
    isolatedManifestFilesChanged: 0,
    localLockFilesChanged: 0,
    rootPackageScriptsChanged: 1,
  },
  "I01 source-change boundary"
);
expectEqual(
  evidence.installProof,
  {
    path: installProofPath,
    sha256: sha256(installProofPath),
    command: contract.installPolicy.argv.join(" "),
  },
  "I01 install-proof reference"
);
expectEqual(
  installProof.runtime,
  {
    node: expectedRuntime.node,
    npm: expectedRuntime.npm,
    timezone: "UTC",
    locale: "C",
  },
  "I01 install-proof runtime"
);
if (
  !installProof.sandboxOutsideRepositoryAncestry ||
  !installProof.sourceTreeUnchanged
) {
  fail(
    "I01 install proof did not preserve external-sandbox/source-tree isolation"
  );
}
expectEqual(
  installProof.root,
  {
    lock: "package-lock.json",
    lockSha256: sha256("package-lock.json"),
    command: contract.installPolicy.argv.join(" "),
    ciExitStatus: 0,
    npmLsCommand: "npm ls --all --json",
    npmLsExitStatus: 1,
    npmLsProblemCount: 15,
    npmLsInternalWorkspacePackages: 12,
    installedOriginVerifier:
      "INTERNAL_DEPS_VERIFY_OK current=109 legacy=28 workspace=100 localTarball=37 installed=verified",
    lockUnchanged: true,
  },
  "I01 root install proof"
);
const runnableProjects = derivedProjects
  .filter((project) => project.mode === "runnable")
  .sort((left, right) => left.manifest.localeCompare(right.manifest));
expectEqual(
  installProof.localRuns.map((run) => run.manifest),
  runnableProjects.map((project) => project.manifest),
  "I01 local install inventory"
);
for (const [index, run] of installProof.localRuns.entries()) {
  const project = runnableProjects[index];
  expectEqual(
    run,
    {
      manifest: project.manifest,
      lock: project.lock.path,
      lockSha256: project.lock.sha256,
      sandboxOutsideRepositoryAncestry: true,
      command: contract.installPolicy.argv.join(" "),
      ciExitStatus: 0,
      npmLsCommand: "npm ls --all --json",
      npmLsExitStatus: 0,
      npmLsProblemCount: 0,
      lockUnchanged: true,
    },
    `${project.id} install proof`
  );
}
expectEqual(
  evidence.validation,
  {
    fullCheck: "passed",
    isolatedVerifier:
      "ISOLATED_PROJECTS_VERIFY_OK projects=16 runnable=14 templates=2 locks=14 edges=37 registryBaselines=21 browser=10 examples=14",
    adversarial: "I01_ISOLATED_PROJECT_ADVERSARIAL_TESTS_OK cases=28",
    externalInstalls:
      "NPM_INSTALL_PROOF_OK root=1 local=14 internal=12 npmLsProblems=15",
    reproducedInstallProof:
      "NPM_INSTALL_PROOF_OK root=1 local=14 internal=12 npmLsProblems=15",
    installedOrigins:
      "INTERNAL_DEPS_VERIFY_OK current=109 legacy=28 workspace=100 localTarball=37 installed=verified",
    installedAdversarial: "N04_INSTALLED_ADVERSARIAL_TESTS_OK cases=18",
    lockStability: "LOCK_STABILITY_OK locks=15",
    formatting: "passed",
  },
  "I01 validation summary"
);
expectEqual(
  evidence.deferred,
  {
    tarballStagingAndExecution: "I02",
    productionBuildAndPackRepair: "P01",
    ciMatrices: "C01",
  },
  "I01 deferred ownership"
);

console.log(
  `ISOLATED_PROJECTS_VERIFY_OK projects=${derivedCounts.projects} runnable=${derivedCounts.runnable} templates=${derivedCounts.templates} locks=${derivedCounts.localLocks} edges=${derivedCounts.internalEdges} registryBaselines=${derivedCounts.registryBaselineRecords} browser=${derivedCounts.browserProjects} examples=${derivedCounts.ordinaryExamples}`
);
