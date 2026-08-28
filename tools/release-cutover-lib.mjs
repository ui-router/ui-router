import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, repository, sha256File } from "./ci-gates-lib.mjs";
import { validateJsonSchema } from "./validate-migration-contract.mjs";
import {
  requireMaintainerApproval,
  validateMilestoneAcceptance,
} from "./milestone-acceptance-lib.mjs";

export const contractPath = "migration/release-cutover.json";
export const schemaPath = "migration/schemas/release-cutover.schema.json";
export { repository };

const expectedForbiddenActions = [
  "npm publish",
  "npm dist-tag",
  "git tag",
  "git push",
  "create GitHub release",
  "archive source repository",
  "redirect source repository",
  "change source repository permissions",
];
const expectedDecisionGateIds = [
  "release-policy",
  "registry-access-and-provenance",
  "publish-order-and-promotion",
  "source-repository-transition",
  "rollback-rehearsal",
];
const expectedPhaseIds = [
  "freeze-and-eligibility",
  "pack-and-consumer-dry-run",
  "publish-and-promotion",
  "git-release-and-observation",
  "source-repository-transition",
  "rollback-rehearsal-and-closeout",
];
const requiredPlanHeadings = [
  "# Release and cutover plan (R01)",
  "## 1. Freeze the candidate and make the release decisions",
  "## 2. Prove the packages before publishing",
  "## 3. Publish in small, checked steps",
  "## 4. Transition the old repositories last",
  "## 5. Rehearse rollback before cutover",
  "## What approval of R01 means",
];

function fail(message) {
  throw new Error(`RELEASE_CUTOVER_PLAN_FAILED: ${message}`);
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
function ids(items) {
  return items.map((item) => item.id);
}

function validateBindings(root, contract) {
  const bindingFiles = {
    sourcesSha256: "migration/sources.json",
    packageArtifactsSha256: "migration/package-artifacts.json",
    packageClassificationSha256: "migration/package-classification.json",
    milestoneAcceptanceSha256: "migration/milestone-acceptance.json",
    cleanReproducibilitySha256: "migration/clean-reproducibility.json",
    workGraphSha256: "migration/work-graph.json",
    planDocumentSha256: "migration/release-cutover-plan.md",
  };
  for (const [field, relative] of Object.entries(bindingFiles)) {
    if (contract.bindings[field] !== sha256File(path.join(root, relative)))
      fail(`${field} binding differs`);
  }
}

function validateInputs(root, contract) {
  const sources = readJson(root, "migration/sources.json");
  const packageArtifacts = readJson(root, "migration/package-artifacts.json");
  const expectedSources = sources.sources.map((source) => source.name);
  const expectedPackages = packageArtifacts.packages.map(({ id, package: name, version }) => ({ id, name, version }));
  equal(contract.sourceRepositories.count, expectedSources.length, "source repository count");
  equal(contract.sourceRepositories.names, expectedSources, "source repository inventory");
  equal(contract.releaseInventory.count, expectedPackages.length, "release package count");
  equal(contract.releaseInventory.packages, expectedPackages, "release package inventory");
}

function validateA01(root, contract) {
  if (commitTree(root, contract.a01.mergeCommit) !== contract.a01.tree)
    fail("A01 merge tree differs");
  if (!isAncestor(root, contract.a01.mergeCommit)) fail("A01 merge is not reachable from HEAD");
}

function validatePlan(root, contract) {
  equal(contract.scope.mode, "design-only", "R01 mode");
  equal(contract.scope.requiresSeparateExecutionApproval, true, "separate execution approval policy");
  equal(contract.scope.forbiddenActions, expectedForbiddenActions, "forbidden live action inventory");
  equal(ids(contract.decisionGates), expectedDecisionGateIds, "decision gate order");
  if (contract.decisionGates.some((gate) => gate.status !== "pending" || gate.approval !== "maintainer"))
    fail("future decision gates are not pending maintainer approvals");
  equal(ids(contract.phases), expectedPhaseIds, "future phase order");
  const gateIds = new Set(expectedDecisionGateIds);
  for (const phase of contract.phases) {
    if (phase.mode !== "future-execution") fail(`${phase.id} is not explicitly future execution`);
    for (const required of phase.requires)
      if (!gateIds.has(required)) fail(`${phase.id} references an unknown decision gate`);
  }
  const planDocument = readFileSync(path.join(root, "migration/release-cutover-plan.md"), "utf8");
  for (const heading of requiredPlanHeadings)
    if (!planDocument.includes(heading)) fail(`plan document is missing ${heading}`);
  for (const term of ["npm unpublish", "observation window", "per-repository", "dry runs"])
    if (!planDocument.includes(term)) fail(`plan document is missing required safeguard: ${term}`);
}

function validateWorkGraph(root) {
  const graph = readJson(root, "migration/work-graph.json");
  const r01 = graph.tasks.find((task) => task.id === "R01");
  if (!r01) fail("work graph omits R01");
  equal(r01.dependsOn, ["A01"], "R01 work-graph dependency");
}

export async function validateReleaseCutoverPlan(options = {}) {
  const root = options.root ? realpathSync(options.root) : repository;
  const source = options.contract ?? path.join(root, contractPath);
  const contract = JSON.parse(readFileSync(source, "utf8"));
  await validateJsonSchema(contract, path.join(root, schemaPath));
  validateBindings(root, contract);
  validateInputs(root, contract);
  validateA01(root, contract);
  validatePlan(root, contract);
  validateWorkGraph(root);
  const milestone = await validateMilestoneAcceptance({ root });
  requireMaintainerApproval(milestone.contract);
  return {
    contract,
    sourceCount: contract.sourceRepositories.count,
    packageCount: contract.releaseInventory.count,
  };
}

export function requirePlanApproval(contract) {
  if (contract.status !== "approved") fail("R01 plan is awaiting maintainer approval");
}
