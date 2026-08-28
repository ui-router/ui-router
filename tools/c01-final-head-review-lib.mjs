import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalJson, repository } from "./ci-gates-lib.mjs";
import { validateJsonSchema } from "./validate-migration-contract.mjs";

export const contractPath = "migration/c01-final-head-review.json";
export const schemaPath = "migration/schemas/c01-final-head-review.schema.json";
export { repository };

const expectedFixes = [
  ["8de3921f0222440f6ec3b1e57966a44ead7d2e35", "fix(ci): trust checked-out container worktree", ["tools/run-ci-gate.mjs"]],
  ["bee278053a4082d55661281221a6ab92fc5103ef", "fix(ci): prepare container checkouts for migration gates", [
    ".github/workflows/ci.yml", "tools/render-ci-workflow.mjs", "tools/test-ci-gates.mjs", "tools/verify-ci-gates.mjs",
  ]],
  ["1276bbe6c746939111f04a0423fb6202cdf28335", "fix(ci): bootstrap reviewed registry tarballs", [
    ".github/workflows/ci.yml", "migration/ci-gates.json", "migration/schemas/ci-gates.schema.json",
    "tools/bootstrap-ci-registry-tarballs.mjs", "tools/ci-gates-lib.mjs", "tools/render-ci-workflow.mjs",
    "tools/test-ci-gates.mjs", "tools/verify-ci-gates.mjs", "tools/verify-integration-evidence.mjs",
  ]],
  ["d86246f2a3f11075fa8fa7696a467900460001c5", "fix(ci): provision pinned history toolchain", [
    ".github/workflows/ci.yml", "migration/ci-gates.json", "migration/schemas/ci-gates.schema.json",
    "tools/bootstrap-ci-uv.mjs", "tools/ci-gates-lib.mjs", "tools/render-ci-workflow.mjs",
    "tools/test-ci-gates.mjs", "tools/verify-ci-gates.mjs", "tools/verify-integration-evidence.mjs",
  ]],
  ["7cd43281168dd15e20a1f64e9bda33bf98b5b231", "fix(angular-hybrid): bundle Zone.js for e2e", ["frameworks/angular-hybrid/examples/example/webpack.config.js"]],
];

function fail(message) {
  throw new Error(`C01_FINAL_HEAD_REVIEW_FAILED: ${message}`);
}
function equal(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} differs`);
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
function changedFiles(root, commit) {
  return git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
    .split("\n")
    .filter(Boolean)
    .sort();
}

export async function validateC01FinalHeadReview(options = {}) {
  const root = options.root ? realpathSync(options.root) : repository;
  const source = options.contract ?? path.join(root, contractPath);
  const contract = JSON.parse(readFileSync(source, "utf8"));
  await validateJsonSchema(contract, path.join(root, schemaPath));

  if (!isAncestor(root, contract.readyForReviewCommit, contract.finalHead.commit))
    fail("ready-for-review commit is not an ancestor of the final head");
  if (!isAncestor(root, contract.finalHead.commit)) fail("final C01 head is not reachable from HEAD");
  if (commitTree(root, contract.finalHead.commit) !== contract.finalHead.tree)
    fail("final C01 head tree differs");
  if (commitTree(root, contract.finalHead.mergeCommit) !== contract.finalHead.tree)
    fail("C01 merge tree differs");
  const mergeParents = git(root, ["show", "-s", "--format=%P", contract.finalHead.mergeCommit]).split(" ").filter(Boolean);
  if (mergeParents.length !== 2 || !mergeParents.includes(contract.finalHead.commit))
    fail("C01 merge does not retain its reviewed final head");

  const actualCommits = git(root, ["rev-list", "--reverse", `${contract.readyForReviewCommit}..${contract.finalHead.commit}`])
    .split("\n")
    .filter(Boolean);
  equal(actualCommits, expectedFixes.map(([commit]) => commit), "post-ready commit sequence");
  for (const [index, [commit, subject, files]] of expectedFixes.entries()) {
    const record = contract.postReadyFixes[index];
    equal([record.commit, record.subject, [...record.files].sort()], [commit, subject, [...files].sort()], `review record fix ${index}`);
    if (git(root, ["show", "-s", "--format=%s", commit]) !== subject)
      fail(`final-head subject differs for ${commit}`);
    equal(changedFiles(root, commit), [...files].sort(), `final-head changed-file set for ${commit}`);
  }
  equal(
    contract.independentReview,
    {
      status: "completed",
      reviewer: "Codex",
      recordedOn: "2026-08-28",
      scope: "Review the exact five post-ready commits, their final tree, the generated CI contract/workflow protections, and the successful final-head CI run.",
      conclusion: "The final-head fixes repair CI/environment and Angular Hybrid e2e prerequisites without removing a required validation gate or authorizing a release side effect.",
    },
    "independent review record"
  );
  equal(
    contract.maintainerApproval,
    {
      approvedBy: "christopherthielen",
      recordedOn: "2026-08-28",
      scope: "Merge pull request #24 after its exact final head and successful CI were reviewed.",
      evidence: "Maintainer authorization was recorded in the Codex migration task before C01 was merged.",
    },
    "maintainer approval record"
  );
  return { contract, fixes: expectedFixes.length };
}
