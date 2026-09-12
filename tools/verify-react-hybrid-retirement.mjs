#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const repository = realpathSync(path.join(import.meta.dirname, ".."));
const packagePath =
  "frameworks/react-hybrid/uirouter-react-hybrid/package.json";
const evidencePath = "migration/evidence/p03/react-hybrid-3.json";
const retiredProjectId = "framework/react-hybrid/integration/react16";
const activeProjectIds = [
  "framework/react-hybrid/integration/react17",
  "framework/react-hybrid/integration/react18",
  "framework/react-hybrid/integration/react19",
];

function fail(message) {
  throw new Error(`REACT_HYBRID_RETIREMENT_FAILED: ${message}`);
}
function read(relative) {
  return readFileSync(path.join(repository, relative), "utf8");
}
function json(relative) {
  return JSON.parse(read(relative));
}
function sha256(relative) {
  return createHash("sha256")
    .update(readFileSync(path.join(repository, relative)))
    .digest("hex");
}
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} differs`);
}

const evidence = json(evidencePath);
equal(
  evidence.source,
  {
    repository: "https://github.com/ui-router/react-hybrid.git",
    tag: "3.0.0",
    commit: "2779bd13aeae470276812d187214e03486e4d9da",
    tree: "fececc538eea5f04b2be64071eb4edfd43db3bea",
  },
  "upstream release"
);
equal(
  evidence.npm,
  {
    package: "@uirouter/react-hybrid",
    version: "3.0.0",
    publishedAt: "2026-09-08T04:12:22.874Z",
    gitHead: "2779bd13aeae470276812d187214e03486e4d9da",
    integrity:
      "sha512-voWGcdaYKy+y1hdbFdc7XUzJin6E7FsluscJ/Ci/G2O0MqraAG1BTXhv/uXNnl9MwsB74np4vsdIkilR8mRNKA==",
    shasum: "c10b6e12ce2b51239b47ed327c7c43a94619653b",
    peerDependencies: {
      angular: "^1.5.0",
      react: "^17.0.0 || ^18.0.0 || ^19.0.0",
    },
    dependencies: {
      "@uirouter/angularjs": "1.1.2",
      "@uirouter/core": "6.1.2",
      "@uirouter/react": "1.0.8",
    },
  },
  "published npm artifact"
);

const manifest = json(packagePath);
if (
  manifest.name !== evidence.npm.package ||
  manifest.version !== evidence.npm.version
)
  fail("package identity differs from the published release");
equal(manifest.peerDependencies, evidence.npm.peerDependencies, "peer range");
equal(manifest.dependencies, evidence.npm.dependencies, "runtime dependencies");
if (manifest.devDependencies["@uirouter/publish-scripts"] !== "^2.7.0")
  fail("publish-scripts range differs from the normalized monorepo range");
if (
  evidence.port.normalizedDifferences?.["@uirouter/publish-scripts"] !==
  "The upstream 3.0.0 source asks for ^2.8.0. The monorepo retains its normalized ^2.7.0 workspace range, which admits the local 2.8.0 package without raising the established minimum."
)
  fail("publish-scripts normalization is not recorded");

const downstream = json(
  "frameworks/react-hybrid/uirouter-react-hybrid/downstream_projects.json"
);
equal(
  downstream,
  {
    integration: {
      react17: "../integration-tests/react17",
      react18: "../integration-tests/react18",
      react19: "../integration-tests/react19",
    },
  },
  "active downstream projects"
);

const activeSourceFiles = [
  "frameworks/react-hybrid/uirouter-react-hybrid/README.md",
  "frameworks/react-hybrid/uirouter-react-hybrid/rollup.config.mjs",
  "frameworks/react-hybrid/uirouter-react-hybrid/src/angularjs/ReactUIViewAdapterComponentLegacy.tsx",
  "frameworks/react-hybrid/uirouter-react-hybrid/src/legacy.ts",
];
for (const relative of activeSourceFiles)
  if (/React 16|React16/.test(read(relative)))
    fail(`${relative} still claims active React 16 support`);

const matrix = json("migration/integration-matrix.json");
const retirement = matrix.retirements.find(
  (record) => record.projectId === retiredProjectId
);
if (
  matrix.retirements.length !== 1 ||
  !retirement ||
  retirement.retiredOn !== "2026-09-08" ||
  retirement.retainedFixture !== evidence.port.retainedFixture ||
  retirement.evidence.path !== evidencePath ||
  retirement.evidence.sha256 !== sha256(evidencePath)
)
  fail("integration retirement record differs");
equal(
  retirement.replacementProjectIds,
  activeProjectIds,
  "replacement integration projects"
);

const isolated = json("migration/isolated-projects.json");
const retained = isolated.projects.find(
  (project) => project.id === retiredProjectId
);
if (
  !retained ||
  retained.manifest !== `${evidence.port.retainedFixture}/package.json` ||
  !existsSync(path.join(repository, retained.manifest)) ||
  sha256(retained.manifest) !== retained.manifestSha256 ||
  sha256(retained.lock.path) !== retained.lock.sha256
)
  fail("frozen I01 React 16 fixture differs");

for (const [relative, expected] of Object.entries(
  evidence.port.retainedFailureFiles
)) {
  const proofPath = `${evidence.port.retainedFailureProof}/${relative}`;
  if (
    !existsSync(path.join(repository, proofPath)) ||
    sha256(proofPath) !== expected
  )
    fail(`historical React 16 failure proof differs: ${relative}`);
}

const ci = json("migration/ci-gates.json");
if (
  ci.currentWaivers.some(
    (waiver) =>
      waiver.projectId === retiredProjectId ||
      waiver.trackingIssue ===
        "https://github.com/ui-router/ui-router/issues/20"
  )
)
  fail("React 16 remains in the current CI waiver inventory");
const shard = ci.integration.shards.find(
  (candidate) => candidate.id === "react-hybrid"
);
equal(shard?.projectIds, activeProjectIds, "React Hybrid CI shard");

const packageArtifacts = json("migration/package-artifacts.json");
const artifact = packageArtifacts.packages.find(
  (record) => record.package === evidence.npm.package
);
if (artifact?.version !== evidence.npm.version)
  fail("package artifact inventory has the wrong React Hybrid version");

const release = json("migration/release-cutover.json");
const releasePackage = release.releaseInventory.packages.find(
  (record) => record.name === evidence.npm.package
);
if (releasePackage?.version !== evidence.npm.version)
  fail("release inventory has the wrong React Hybrid version");

const rootLock = json("package-lock.json");
const lockPackage =
  rootLock.packages[packagePath.replace(/\/package\.json$/, "")];
if (
  lockPackage?.version !== evidence.npm.version ||
  lockPackage.peerDependencies?.react !== evidence.npm.peerDependencies.react ||
  lockPackage.devDependencies?.["@uirouter/publish-scripts"] !== "^2.7.0"
)
  fail("root lock does not describe React Hybrid 3.0.0");

console.log(
  `REACT_HYBRID_RETIREMENT_OK version=${manifest.version} active=${activeProjectIds.length} retired=1`
);
