#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  contractPath,
  repository,
  validateCleanReproducibility,
  verifyCleanReproducibilityProof,
  workflowPath,
} from "./clean-reproducibility-lib.mjs";
import { renderReproducibilityWorkflow } from "./render-reproducibility-workflow.mjs";

function fail(message) {
  throw new Error(`CLEAN_REPRODUCIBILITY_VERIFY_FAILED: ${message}`);
}
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
for (let index = 2; index < process.argv.length; index += 1) {
  if (
    !["--contract", "--workflow", "--proof"].includes(process.argv[index]) ||
    !process.argv[index + 1]
  )
    fail(`unknown argument ${process.argv[index]}`);
  index += 1;
}
const source = value("--contract") ?? path.join(repository, contractPath);
const workflow = value("--workflow") ?? path.join(repository, workflowPath);
const { contract, ci, packageArtifacts, root } = await validateCleanReproducibility({
  contract: source,
});
if (!existsSync(workflow)) fail("generated workflow is missing");
const actual = readFileSync(workflow, "utf8");
if (actual !== renderReproducibilityWorkflow(contract))
  fail("generated workflow differs from its contract");
const count = (pattern) => actual.match(pattern)?.length ?? 0;
if (count(/^  reproducibility:$/gm) !== 1)
  fail("workflow job topology differs");
for (const action of Object.values(contract.actions)) {
  if (count(new RegExp(`@${action.sha}`, "g")) === 0)
    fail("workflow action pin is absent");
}
for (const required of [
  `image: ${contract.runtime.ciImage}`,
  "          fetch-depth: 0",
  'run: git config --global --add safe.directory "$GITHUB_WORKSPACE"',
  `node-version: ${contract.runtime.node}`,
  contract.runtime.npmInstallCommand.join(" "),
  contract.runtime.npmRegistryBootstrapCommand.join(" "),
  "node tools/verify-clean-reproducibility.mjs",
  `node tools/prove-clean-reproducibility.mjs --output ${contract.proof.output}`,
  `--proof ${contract.proof.output}`,
])
  if (!actual.includes(required)) fail(`workflow is missing ${required}`);
for (const forbidden of [
  "pull_request_target",
  "schedule:",
  "actions/cache",
  "continue-on-error",
  "TURBO_TOKEN",
  "TURBO_TEAM",
  "--force",
  "--legacy-peer-deps",
  "@main",
  "@master",
  "@latest",
])
  if (actual.includes(forbidden)) fail(`workflow contains forbidden token ${forbidden}`);
if (count(/actions\/upload-artifact@/g) !== 2)
  fail("workflow proof and failure artifact uploads differ");
if (value("--proof")) {
  const proofPath = path.resolve(root, value("--proof"));
  const relative = path.relative(path.join(root, ".ci-results/reproducibility"), proofPath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    fail("proof must remain in .ci-results/reproducibility");
  if (!existsSync(proofPath)) fail("proof is missing");
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  const verified = verifyCleanReproducibilityProof({
    proof,
    contract,
    ci,
    packageArtifacts,
    root,
  });
  console.log(
    `CLEAN_REPRODUCIBILITY_PROOF_OK revision=${verified.revision} fingerprint=${verified.fingerprintSha256}`
  );
}
console.log("CLEAN_REPRODUCIBILITY_OK runs=2 snapshot=git-archive");
