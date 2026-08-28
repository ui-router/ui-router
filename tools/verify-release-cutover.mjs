#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  requirePlanApproval,
  validateReleaseCutoverPlan,
} from "./release-cutover-lib.mjs";

function fail(message) {
  throw new Error(`RELEASE_CUTOVER_PLAN_VERIFY_FAILED: ${message}`);
}

let contractPath = null;
let requireApproval = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--require-plan-approval") {
    requireApproval = true;
    continue;
  }
  if (argument === "--contract" && process.argv[index + 1]) {
    contractPath = path.resolve(process.argv[index + 1]);
    index += 1;
    continue;
  }
  fail(`unknown argument ${argument}`);
}

const { contract, sourceCount, packageCount } = await validateReleaseCutoverPlan({
  contract: contractPath ?? undefined,
});
if (requireApproval) requirePlanApproval(contract);
console.log(
  `RELEASE_CUTOVER_PLAN_OK task=R01 status=${contract.status} packages=${packageCount} sources=${sourceCount} phases=${contract.phases.length} gates=${contract.decisionGates.length}`
);
