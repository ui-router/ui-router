import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  canonicalJson,
  repository,
  sha256,
  sha256File,
} from "./ci-gates-lib.mjs";
import { validateJsonSchema } from "./validate-migration-contract.mjs";

export const contractPath = "migration/clean-reproducibility.json";
export const schemaPath = "migration/schemas/clean-reproducibility.schema.json";
export const workflowPath = ".github/workflows/reproducibility.yml";
export { repository };

function fail(message) {
  throw new Error(`CLEAN_REPRODUCIBILITY_FAILED: ${message}`);
}
function equal(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) fail(`${label} differs`);
}
function git(root, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}
function expectedCommands() {
  return [
    {
      id: "install",
      argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    },
    {
      id: "prepare-browser",
      argv: ["node", "tools/prepare-workspace-browser.mjs"],
    },
    {
      id: "setup-browser",
      argv: [
        "npm",
        "run",
        "setup:browser",
        "--",
        "--concurrency=1",
        "--cache=local:",
      ],
    },
    {
      id: "build",
      argv: ["npm", "run", "build", "--", "--cache=local:"],
    },
    {
      id: "test",
      argv: [
        "npm",
        "run",
        "test",
        "--",
        "--cache=local:",
        "--env-mode=loose",
      ],
    },
    { id: "prove-packages", argv: ["npm", "run", "prove:package-artifacts"] },
    {
      id: "stage-packages",
      argv: [
        "node",
        "tools/stage-ci-package-artifacts.mjs",
        "--output",
        ".ci-artifacts/packages",
      ],
    },
    {
      id: "verify-docs-waivers",
      argv: [
        "node",
        "tools/verify-ci-docs-waivers.mjs",
        "--output",
        ".ci-results/docs/waivers.json",
      ],
    },
    {
      id: "cleanup-browser",
      argv: ["node", "tools/prepare-workspace-browser.mjs", "--cleanup"],
    },
  ];
}

export function cleanReproducibilityFingerprint({
  revision,
  tree,
  archiveSha256,
  contract,
  packageManifest,
  packageArtifacts,
  docsWaivers,
  ci,
}) {
  const expectedArtifactIds = ci.artifacts.packages.artifactIds;
  if (!Array.isArray(packageManifest.artifacts))
    fail("package stage manifest has no artifacts");
  const artifacts = packageManifest.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    package: artifact.package,
    version: artifact.version,
    filename: artifact.filename,
    sha256: artifact.sha256,
    integrity: artifact.integrity,
    size: artifact.size,
    fileCount: artifact.fileCount,
    metadataSha256: artifact.metadataSha256,
    filesSha256: artifact.filesSha256,
  }));
  if (
    canonicalJson(artifacts.map((artifact) => artifact.artifactId)) !==
    canonicalJson(expectedArtifactIds)
  )
    fail("package stage manifest artifact inventory differs");
  const packageById = new Map(
    packageArtifacts.packages.map((record) => [record.id, record])
  );
  for (const artifact of artifacts) {
    const expected = packageById.get(artifact.artifactId);
    if (
      !expected ||
      artifact.package !== expected.package ||
      artifact.version !== expected.version ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !/^[a-f0-9]{64}$/.test(artifact.metadataSha256) ||
      !/^[a-f0-9]{64}$/.test(artifact.filesSha256) ||
      !/^sha512-/.test(artifact.integrity || "") ||
      !Number.isInteger(artifact.size) ||
      !Number.isInteger(artifact.fileCount)
    )
      fail(`package artifact fingerprint is malformed: ${artifact.artifactId}`);
  }
  if (
    docsWaivers.status !== "ok" ||
    docsWaivers.contractSha256 !== contract.bindings.ciGatesSha256 ||
    docsWaivers.baselinesSha256 !== contract.bindings.baselinesSha256 ||
    !Array.isArray(docsWaivers.records) ||
    docsWaivers.records.length !== ci.docsWaivers.length
  )
    fail("documentation waiver output differs");
  const docs = docsWaivers.records.map((record) => ({
    baselineId: record.baselineId,
    status: record.status,
    owner: record.owner,
    reason: record.reason,
    trackingIssue: record.trackingIssue,
    expires: record.expires,
    evidenceSha256: record.evidenceSha256,
  }));
  const expectedDocs = ci.docsWaivers.map((record) => ({
    baselineId: record.baselineId,
    status: "waived-failure",
    owner: record.waiver.owner,
    reason: record.waiver.reason,
    trackingIssue: record.waiver.trackingIssue,
    expires: record.waiver.expires,
    evidenceSha256: record.evidence.sha256,
  }));
  if (canonicalJson(docs) !== canonicalJson(expectedDocs))
    fail("documentation waiver inventory differs");
  return {
    source: {
      revision,
      tree,
      archiveSha256,
      packageLockSha256: contract.bindings.packageLockSha256,
    },
    bindings: contract.bindings,
    packages: artifacts,
    waivers: {
      docs,
      current: ci.currentWaivers,
    },
  };
}

export function assertIdenticalFingerprints(left, right) {
  if (canonicalJson(left) !== canonicalJson(right))
    fail("independent clean-run fingerprints differ");
}

export async function validateCleanReproducibility(options = {}) {
  const root = options.root ? realpathSync(options.root) : repository;
  const source = options.contract ?? path.join(root, contractPath);
  const contract = JSON.parse(readFileSync(source, "utf8"));
  await validateJsonSchema(contract, path.join(root, schemaPath));

  const bindingFiles = {
    ciGatesSha256: "migration/ci-gates.json",
    packageJsonSha256: "package.json",
    packageLockSha256: "package-lock.json",
    turboSha256: "turbo.json",
    packageArtifactsSha256: "migration/package-artifacts.json",
    baselinesSha256: "migration/baselines.json",
    integrationMatrixSha256: "migration/integration-matrix.json",
    executionLockSha256: "migration/execution-lock.json",
  };
  for (const [field, relative] of Object.entries(bindingFiles))
    if (contract.bindings[field] !== sha256File(path.join(root, relative)))
      fail(`${field} binding differs`);

  if (git(root, ["rev-parse", `${contract.c01.head}^{tree}`]) !== contract.c01.tree)
    fail("C01 head tree differs");
  if (git(root, ["rev-parse", `${contract.c01.mergeCommit}^{tree}`]) !== contract.c01.tree)
    fail("C01 merge tree differs");
  if (
    spawnSync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "merge-base",
        "--is-ancestor",
        contract.c01.head,
        "HEAD",
      ],
      { cwd: root }
    ).status !== 0
  )
    fail("C01 head is not an ancestor of HEAD");
  const mergeParents = git(root, ["rev-list", "--parents", "-n", "1", contract.c01.mergeCommit]).split(" ");
  if (
    mergeParents.length !== 3 ||
    mergeParents[0] !== contract.c01.mergeCommit ||
    !mergeParents.slice(1).includes(contract.c01.head)
  )
    fail("C01 merge commit does not retain its reviewed head");

  const ci = readJson(root, "migration/ci-gates.json");
  const packageArtifacts = readJson(root, "migration/package-artifacts.json");
  equal(contract.runtime.ciImage, ci.runtime.ciImage, "C01 CI image");
  equal(contract.runtime.ciImageDigest, ci.runtime.ciImageDigest, "C01 CI image digest");
  equal(contract.runtime.node, ci.runtime.node, "C01 Node pin");
  equal(contract.runtime.npm, ci.runtime.npm, "C01 npm pin");
  equal(contract.runtime.architecture, ci.runtime.architecture, "C01 architecture");
  equal(contract.runtime.environment, ci.runtime.environment, "C01 environment");
  equal(contract.runtime.npmInstallCommand, ci.runtime.npmInstallCommand, "C01 npm provisioning");
  equal(
    contract.runtime.npmRegistryBootstrapCommand,
    ci.runtime.npmRegistryBootstrapCommand,
    "C01 registry bootstrap"
  );
  for (const action of Object.keys(contract.actions))
    equal(contract.actions[action], ci.actions[action], `C01 ${action} action`);
  equal(contract.commands, expectedCommands(), "C02 command sequence");
  if (new Set(contract.commands.map((command) => command.id)).size !== contract.commands.length)
    fail("C02 command ids repeat");
  for (const command of contract.commands) {
    const joined = command.argv.join(" ");
    if (/--(?:force|legacy-peer-deps)\b/.test(joined))
      fail(`${command.id} bypasses dependency policy`);
    if (/\b(?:yarn|pnpm|yalc)\b/i.test(joined))
      fail(`${command.id} uses a non-npm package manager`);
    if (command.argv[0] === "npm" && ["i", "install"].includes(command.argv[1]))
      fail(`${command.id} uses npm install`);
  }
  if (contract.workflow.proofArtifactName !== "clean-reproducibility-${{ github.sha }}")
    fail("proof artifact name differs");
  if (contract.workflow.timeoutMinutes < 120)
    fail("workflow timeout is too short for two clean runs");
  return { contract, ci, packageArtifacts, root };
}

export function verifyCleanReproducibilityProof({
  proof,
  contract,
  ci,
  packageArtifacts,
  root,
}) {
  if (
    proof.schemaVersion !== 1 ||
    proof.task !== "C02" ||
    proof.owner !== contract.owner ||
    proof.contractSha256 !== sha256File(path.join(root, contractPath))
  )
    fail("proof identity differs");
  const revision = git(root, ["rev-parse", "HEAD"]);
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  if (
    proof.repository?.revision !== revision ||
    proof.repository?.tree !== tree ||
    proof.repository?.c01Head !== contract.c01.head ||
    proof.repository?.c01Tree !== contract.c01.tree
  )
    fail("proof repository binding differs");
  if (!Array.isArray(proof.runs) || proof.runs.length !== contract.proof.runs)
    fail("proof run count differs");
  const fingerprints = [];
  for (const [index, run] of proof.runs.entries()) {
    if (
      run.id !== index + 1 ||
      !Array.isArray(run.commands) ||
      canonicalJson(run.commands) !== canonicalJson(contract.commands.map((command) => command.id)) ||
      !run.fingerprint ||
      run.fingerprintSha256 !== sha256(canonicalJson(run.fingerprint))
    )
      fail(`proof run ${index + 1} is malformed`);
    if (
      run.fingerprint.source?.revision !== revision ||
      run.fingerprint.source?.tree !== tree ||
      run.fingerprint.source?.packageLockSha256 !== contract.bindings.packageLockSha256
    )
      fail(`proof run ${index + 1} source binding differs`);
    const expected = cleanReproducibilityFingerprint({
      revision,
      tree,
      archiveSha256: run.fingerprint.source.archiveSha256,
      contract,
      packageManifest: { artifacts: run.fingerprint.packages },
      packageArtifacts,
      docsWaivers: {
        status: "ok",
        contractSha256: contract.bindings.ciGatesSha256,
        baselinesSha256: contract.bindings.baselinesSha256,
        records: run.fingerprint.waivers?.docs,
      },
      ci,
    });
    equal(run.fingerprint, expected, `proof run ${index + 1} fingerprint`);
    fingerprints.push(run.fingerprint);
  }
  assertIdenticalFingerprints(fingerprints[0], fingerprints[1]);
  if (
    proof.comparison?.status !== "identical" ||
    proof.comparison?.fingerprintSha256 !== sha256(canonicalJson(fingerprints[0]))
  )
    fail("proof comparison differs");
  return { revision, tree, fingerprintSha256: proof.comparison.fingerprintSha256 };
}
