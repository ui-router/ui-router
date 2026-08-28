import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, repository, sha256File } from "./ci-gates-lib.mjs";
import { validateJsonSchema } from "./validate-migration-contract.mjs";

export const contractPath = "migration/milestone-acceptance.json";
export const schemaPath = "migration/schemas/milestone-acceptance.schema.json";
export { repository };

const expectedCommands = [
  "verify:root-config",
  "verify:locks",
  "verify:package-manager",
  "verify:layout",
  "verify:internal-deps",
  "verify:source-aliases",
  "verify:turbo",
  "verify:isolated",
  "verify:package-artifacts",
  "verify:integration-matrix",
  "verify:integration-evidence",
  "verify:ci",
  "verify:reproducibility",
  "verify:contracts",
  "verify:work-graph",
];
const expectedReview = [
  ["docs-source-container", "https://github.com/ui-router/ui-router/pull/8", "2026-09-30"],
  ["react16-peer-range", "https://github.com/ui-router/ui-router/issues/20", "2026-10-31"],
  ["angularjs-eslint-root-resolution", "https://github.com/ui-router/ui-router/issues/22", "2026-10-31"],
];
const expectedAcceptance = {
  status: "approved-with-exception",
  approvedBy: "christopherthielen",
  recordedOn: "2026-08-28",
  exception: {
    id: "h01-retained-archive-unavailable",
    originalCriterion: "Remote, retained-mirror, and offline-bundle rerun identity plus independent verification pass under the exact locked history toolchain.",
    reason: "The locked H01 mirrors, offline bundles, and wrapper artifact were unavailable to the A01 acceptance workspace after the import.",
    fallback: "Validate the 16 sibling source checkouts against the locked default commits and tag objects, using each checkout's origin only when a locked tag object is absent locally.",
    proves: [
      "Every locked default-head object remains available in a source checkout.",
      "Every locked accepted or excluded tag object remains available locally or from the recorded origin remote.",
      "The imported history, accepted tags, and all other A01 checks remain internally consistent.",
    ],
    doesNotProve: [
      "The original H01 mirror and offline-bundle bytes were retained.",
      "A rerun under the original locked wrapper and toolchain produces byte-identical remote, mirror, and bundle import outputs.",
    ],
    followUp: "A future history rerun or release/cutover execution must not treat this fallback as proof of byte-identical H01 archive reproduction.",
  },
};

function fail(message) {
  throw new Error(`MILESTONE_ACCEPTANCE_FAILED: ${message}`);
}
function equal(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} differs`);
}
function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}
function git(root, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function isAncestor(root, ancestor, descendant = "HEAD") {
  return spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: root }
  ).status === 0;
}
function commitTree(root, commit) {
  return git(root, ["rev-parse", `${commit}^{tree}`]);
}
function gitResult(root, args) {
  return spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}
function gitOptional(root, args) {
  const result = gitResult(root, args);
  return result.status === 0 ? result.stdout.trim() : null;
}
function gitSucceeds(root, args) {
  return gitResult(root, args).status === 0;
}
function tagNames(root) {
  return git(root, ["tag", "--list"]).split("\n").filter(Boolean).sort();
}
function commitMap(root, source) {
  const rows = readFileSync(path.join(root, "migration/evidence/imports", source, "commit-map"), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("old "));
  const result = new Map();
  for (const row of rows) {
    const [oldCommit, newCommit, ...rest] = row.trim().split(/\s+/);
    if (!/^[a-f0-9]{40}$/.test(oldCommit) || !/^[a-f0-9]{40}$/.test(newCommit) || rest.length > 0)
      fail(`${source} commit map has malformed row`);
    if (result.has(oldCommit)) fail(`${source} commit map repeats a source commit`);
    result.set(oldCommit, newCommit);
  }
  if (result.size === 0) fail(`${source} commit map is empty`);
  return result;
}

function validateMergeMilestone(commit, root, label) {
  if (commitTree(root, commit.head) !== commit.tree) fail(`${label} reviewed head tree differs`);
  if (commitTree(root, commit.mergeCommit) !== commit.tree) fail(`${label} merge tree differs`);
  if (!isAncestor(root, commit.mergeCommit)) fail(`${label} merge is not reachable from HEAD`);
  const parents = git(root, ["show", "-s", "--format=%P", commit.mergeCommit]).split(" ").filter(Boolean);
  if (parents.length !== 2 || !parents.includes(commit.head)) fail(`${label} merge does not retain its reviewed head`);
}

function validateSquashMilestone(commit, root, label) {
  // A squash merge retains its content tree but not its PR head object.  The
  // head is therefore not reliably present in a clean CI checkout; bind the
  // reachable merge commit and its exact tree instead.
  if (commitTree(root, commit.mergeCommit) !== commit.tree) fail(`${label} merge tree differs`);
  if (!isAncestor(root, commit.mergeCommit)) fail(`${label} merge is not reachable from HEAD`);
}

function validateHistory({ root, contract, sources, executionLock, importLock, summary }) {
  if (!isAncestor(root, contract.history.importMergeCommit)) fail("official history import is not reachable from HEAD");
  equal(sources.sources.length, contract.history.sourceCount, "source count");
  equal(summary.imports.length, contract.history.sourceCount, "import evidence source count");
  equal(executionLock.sources.length, contract.history.sourceCount, "execution-lock source count");
  equal(importLock.targetBaseCommit, executionLock.targetBase, "import lock target base");
  equal(summary.baseCommit, executionLock.targetBase, "import evidence target base");
  const sourceNames = sources.sources.map((source) => source.name);
  equal(summary.imports.map((item) => item.name), sourceNames, "import evidence manifest order");
  equal(executionLock.sources.map((source) => source.name), sourceNames, "execution-lock manifest order");

  const expectedTags = new Map();
  const excludedTags = new Set();
  const mappedCommits = new Set();
  let releaseTagCount = 0;
  for (const source of sources.sources) {
    const evidence = summary.imports.find((item) => item.name === source.name);
    const lockSource = executionLock.sources.find((item) => item.name === source.name);
    if (!evidence || !lockSource) fail(`${source.name} is missing lock or import evidence`);
    if (evidence.sourceHead !== source.defaultHead || lockSource.defaultHead !== source.defaultHead)
      fail(`${source.name} default head differs from its source manifest`);
    if (lockSource.tagSnapshotSha256 !== source.tagSnapshotSha256)
      fail(`${source.name} tag snapshot differs from its source manifest`);
    if (!isAncestor(root, evidence.mergeCommit)) fail(`${source.name} merge commit is not reachable`);
    const parents = git(root, ["show", "-s", "--format=%P", evidence.mergeCommit]).split(" ").filter(Boolean);
    if (parents.length !== 2 || !parents.includes(evidence.rewrittenHead))
      fail(`${source.name} import merge does not retain rewritten head`);
    const refs = readJson(root, `migration/evidence/imports/${source.name}/refs.json`);
    if (refs.sourceHead !== source.defaultHead || refs.rewrittenHead !== evidence.rewrittenHead)
      fail(`${source.name} ref evidence differs from source/import evidence`);
    const map = commitMap(root, source.name);
    if (map.size < source.defaultBranchCommitCount)
      fail(`${source.name} commit map omits default-branch commits`);
    if (map.get(source.defaultHead) !== evidence.rewrittenHead)
      fail(`${source.name} default head map differs`);
    for (const mappedCommit of map.values()) mappedCommits.add(mappedCommit);
    equal(refs.tags.length, source.releaseTags.length, `${source.name} release-tag evidence count`);
    for (const tag of source.releaseTags) {
      const recorded = refs.tags.find((entry) => entry.targetName === tag.targetName);
      if (!recorded) fail(`${source.name} is missing tag evidence for ${tag.targetName}`);
      if (
        recorded.originalObject !== tag.objectId ||
        recorded.originalCommit !== tag.targetCommit ||
        recorded.rewrittenCommit !== map.get(tag.targetCommit)
      )
        fail(`${source.name} tag evidence differs for ${tag.targetName}`);
      if (expectedTags.has(tag.targetName)) fail(`duplicate accepted tag ${tag.targetName}`);
      expectedTags.set(tag.targetName, recorded);
      releaseTagCount += 1;
    }
    for (const tag of source.excludedTags) {
      const targetName = `${source.tagNamespace}${tag.name}`;
      if (expectedTags.has(targetName) || excludedTags.has(targetName))
        fail(`${source.name} excluded tag collides with an accepted tag`);
      excludedTags.add(targetName);
    }
  }
  equal(releaseTagCount, contract.history.releaseTagCount, "release-tag count");
  const actualTags = tagNames(root);
  equal(actualTags, [...expectedTags.keys()].sort(), "final tag namespace");
  const visibleCommits = new Set(
    git(root, ["rev-list", "HEAD", ...actualTags]).split("\n").filter(Boolean)
  );
  for (const mappedCommit of mappedCommits)
    if (!visibleCommits.has(mappedCommit))
      fail("mapped history is not reachable from main or an accepted tag");
  for (const [name, expected] of expectedTags) {
    if (git(root, ["rev-parse", `refs/tags/${name}`]) !== expected.rewrittenObject)
      fail(`accepted tag object differs: ${name}`);
    if (git(root, ["rev-parse", `refs/tags/${name}^{}`]) !== expected.rewrittenCommit)
      fail(`accepted tag commit differs: ${name}`);
    const source = sources.sources.find((item) => name.startsWith(item.tagNamespace));
    const paths = git(root, ["ls-tree", "-r", "--name-only", `${name}^{}`]).split("\n").filter(Boolean);
    if (!source || paths.length === 0 || paths.some((entry) => !entry.startsWith(`${source.destinationPrefix}/`)))
      fail(`accepted tag tree is not fully prefixed: ${name}`);
  }
  for (const name of excludedTags)
    if (actualTags.includes(name)) fail(`excluded source tag remains: ${name}`);
  for (const namespace of ["refs/replace", "refs/notes", "refs/stash"]) {
    if (git(root, ["for-each-ref", "--format=%(refname)", namespace]))
      fail(`forbidden imported ref remains under ${namespace}`);
  }
}

export async function validateMilestoneAcceptance(options = {}) {
  const root = options.root ? realpathSync(options.root) : repository;
  const source = options.contract ?? path.join(root, contractPath);
  const contract = JSON.parse(readFileSync(source, "utf8"));
  await validateJsonSchema(contract, path.join(root, schemaPath));

  const bindingFiles = {
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
  };
  for (const [field, relative] of Object.entries(bindingFiles)) {
    if (contract.bindings[field] !== sha256File(path.join(root, relative)))
      fail(`${field} binding differs`);
  }
  validateMergeMilestone(contract.c01, root, "C01");
  validateSquashMilestone(contract.c02, root, "C02");
  if (git(root, ["show", "-s", "--format=%P", contract.c02.mergeCommit]).trim() !== contract.c01.mergeCommit)
    fail("C02 squash merge parent differs from C01 merge");

  const sources = readJson(root, "migration/sources.json");
  const executionLock = readJson(root, "migration/execution-lock.json");
  const importLock = readJson(root, "migration/import-lock.json");
  const summary = readJson(root, "migration/evidence/summary.json");
  validateHistory({ root, contract, sources, executionLock, importLock, summary });

  const packageJson = readJson(root, "package.json");
  equal(contract.requiredCommands, expectedCommands, "required acceptance command inventory");
  for (const command of contract.requiredCommands) {
    if (typeof packageJson.scripts?.[command] !== "string") fail(`root script is missing: ${command}`);
  }
  const ci = readJson(root, "migration/ci-gates.json");
  if (ci.docsWaivers.length !== 4 || ci.currentWaivers.length !== 2)
    fail("CI waiver inventory differs");
  equal(
    contract.maintainerReview.items.map((item) => [item.id, item.trackingIssue, item.expires]),
    expectedReview,
    "maintainer review inventory"
  );
  equal(
    contract.retainedInputs,
    { mode: "source-checkouts", checkoutRoot: "..", tagFallback: "origin" },
    "retained H01 input policy"
  );
  equal(contract.acceptance, expectedAcceptance, "A01 approved exception record");
  const waiverPairs = [
    ...ci.docsWaivers.map((item) => [item.waiver.trackingIssue, item.waiver.expires]),
    ...ci.currentWaivers.map((item) => [item.trackingIssue, item.expires]),
  ];
  equal(
    [...new Set(waiverPairs.map((item) => canonicalJson(item)))].sort(),
    [
      canonicalJson(["https://github.com/ui-router/ui-router/issues/20", "2026-10-31"]),
      canonicalJson(["https://github.com/ui-router/ui-router/issues/22", "2026-10-31"]),
      canonicalJson(["https://github.com/ui-router/ui-router/pull/8", "2026-09-30"]),
    ].sort(),
    "CI waiver risk inventory"
  );
  return { contract, root, releaseTagCount: contract.history.releaseTagCount };
}

export function requireMaintainerApproval(contract) {
  if (contract.maintainerReview.status !== "approved")
    fail("maintainer review is still pending");
  if (contract.acceptance.status !== "approved-with-exception")
    fail("A01 exception has not been approved");
}

function validateSourceCheckoutInputs(root, sources, retention, sourceRootOverride) {
  const requestedRoot = sourceRootOverride ?? path.resolve(root, retention.checkoutRoot);
  if (!existsSync(requestedRoot)) fail("retained source checkout root is missing");
  const checkoutRoot = realpathSync(requestedRoot);
  let remoteRecoveries = 0;
  for (const source of sources.sources) {
    const checkout = path.join(checkoutRoot, source.name);
    if (!existsSync(checkout) || gitOptional(root, ["-C", checkout, "rev-parse", "--is-inside-work-tree"]) !== "true")
      fail(`${source.name} retained source checkout is missing`);
    if (!gitSucceeds(root, ["-C", checkout, "cat-file", "-e", `${source.defaultHead}^{commit}`]))
      fail(`${source.name} retained source checkout lacks its locked default head`);
    let remoteTags = null;
    for (const tag of [...source.releaseTags, ...source.excludedTags]) {
      if (gitOptional(root, ["-C", checkout, "rev-parse", "--verify", tag.sourceRef]) === tag.objectId) continue;
      if (!remoteTags) {
        const output = git(root, ["-C", checkout, "ls-remote", "--tags", retention.tagFallback]);
        remoteTags = new Map(
          output
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(/\s+/))
            .filter((parts) => parts.length === 2 && !parts[1].endsWith("^{}"))
            .map(([objectId, ref]) => [ref, objectId])
        );
      }
      if (remoteTags.get(tag.sourceRef) !== tag.objectId)
        fail(`${source.name} retained source tag differs or is unavailable: ${tag.name}`);
      remoteRecoveries += 1;
    }
  }
  return { checkoutRoot, remoteRecoveries };
}

export function validateRetainedHistoryInputs(root = repository, options = {}) {
  const executionLock = readJson(root, "migration/execution-lock.json");
  const sources = readJson(root, "migration/sources.json");
  const contract = options.contract ?? readJson(root, contractPath);
  if (contract.retainedInputs?.mode !== "source-checkouts") fail("retained H01 input policy is unsupported");
  if (executionLock.sources.length !== sources.sources.length)
    fail("execution lock source count differs from retained source manifest");
  return validateSourceCheckoutInputs(root, sources, contract.retainedInputs, options.sourceRoot);
}
