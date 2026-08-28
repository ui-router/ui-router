#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  contractPath,
  repository,
  validateCiGates,
  workflowPath,
} from "./ci-gates-lib.mjs";
import { renderWorkflow } from "./render-ci-workflow.mjs";

function fail(message) {
  throw new Error(`CI_GATES_FAILED: ${message}`);
}
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
for (let index = 2; index < process.argv.length; index += 1) {
  if (
    !["--contract", "--workflow"].includes(process.argv[index]) ||
    !process.argv[index + 1]
  )
    fail(`unknown argument ${process.argv[index]}`);
  index += 1;
}
const source = value("--contract") ?? path.join(repository, contractPath);
const workflow = value("--workflow") ?? path.join(repository, workflowPath);
const { contract } = await validateCiGates({ contract: source, workflow });
const actual = readFileSync(workflow, "utf8");
const expected = renderWorkflow(contract);
if (actual !== expected) fail("generated workflow differs from its contract");
const count = (pattern) => actual.match(pattern)?.length ?? 0;
if (
  count(
    /^  (?:contracts|source|packages|browser|docs|integration|required):$/gm
  ) !== 7
)
  fail("workflow job topology differs");
if (
  count(
    new RegExp(
      `image: ${contract.runtime.ciImage.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      )}`,
      "g"
    )
  ) !== 6
)
  fail("not every executable job uses the exact CI image");
if (
  count(
    new RegExp(`actions/checkout@${contract.actions.checkout.sha}`, "g")
  ) !== 6 ||
  count(
    new RegExp(`actions/setup-node@${contract.actions.setupNode.sha}`, "g")
  ) !== 6 ||
  count(
    new RegExp(
      `actions/download-artifact@${contract.actions.downloadArtifact.sha}`,
      "g"
    )
  ) !== 1 ||
  count(
    new RegExp(
      `actions/upload-artifact@${contract.actions.uploadArtifact.sha}`,
      "g"
    )
  ) !== 7
)
  fail("workflow action pin usage differs");
if (
  count(/^          fetch-depth: 0$/gm) !== 6 ||
  count(
    /run: git config --global --add safe\.directory "\$GITHUB_WORKSPACE"/g
  ) !== 6
)
  fail("workflow checkout history or safe-directory configuration differs");
if (/@(?:v|main|master|latest)\b/.test(actual))
  fail("workflow contains a mutable action or image reference");
const npmProvisioning = `        run: ${contract.runtime.npmInstallCommand.join(
  " "
)}`;
if (actual.split(npmProvisioning).length - 1 !== 6)
  fail("workflow npm provisioning count differs");
if (actual.replaceAll(npmProvisioning, "").includes("npm install"))
  fail("workflow contains an unreviewed npm install");
const npmRegistryBootstrap = `        run: ${contract.runtime.npmRegistryBootstrapCommand.join(
  " "
)}`;
if (actual.split(npmRegistryBootstrap).length - 1 !== 6)
  fail("workflow npm registry bootstrap count differs");
const uvBootstrap = `        run: ${contract.runtime.uv.bootstrapCommand.join(
  " "
)}`;
if (actual.split(uvBootstrap).length - 1 !== 1)
  fail("workflow uv bootstrap count differs");
for (const forbidden of [
  "pull_request_target",
  "schedule:",
  "actions/cache",
  "continue-on-error",
  "TURBO_TOKEN",
  "TURBO_TEAM",
  "dependabot",
  "--force",
  "--legacy-peer-deps",
])
  if (actual.includes(forbidden))
    fail(`workflow contains forbidden token ${forbidden}`);
if (
  count(/^    if: always\(\)$/gm) !== 1 ||
  !actual.includes("  required:\n    name: Required\n    if: always()")
)
  fail("required aggregate is not fail-closed");
for (const need of contract.aggregate.needs) {
  if (!actual.includes(`test "\${{ needs.${need}.result }}" = "success"`))
    fail(`required aggregate does not enforce ${need}`);
}
if (
  !actual.includes(`name: ${contract.workflow.packageArtifactName}`) ||
  !actual.includes(`path: ${contract.integration.inputDirectory}`)
)
  fail("producer/consumer artifact handoff differs");
if (count(/run: node tools\/run-ci-gate\.mjs --job /g) !== 6)
  fail("workflow does not delegate exactly six gate executions");
console.log(
  `CI_GATES_OK baselines=${contract.counts.baselineRecords} gates=${contract.counts.logicalGates} jobs=${contract.counts.executableJobs} shards=${contract.counts.integrationShards}`
);
