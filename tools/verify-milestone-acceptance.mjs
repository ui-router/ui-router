#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  repository,
  requireMaintainerApproval,
  validateRetainedHistoryInputs,
  validateMilestoneAcceptance,
} from "./milestone-acceptance-lib.mjs";

function fail(message) {
  throw new Error(`MILESTONE_ACCEPTANCE_VERIFY_FAILED: ${message}`);
}

let contractPath = null;
let requireReview = false;
let requireRetainedInputs = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--require-maintainer-review") {
    requireReview = true;
    continue;
  }
  if (argument === "--require-retained-inputs") {
    requireRetainedInputs = true;
    continue;
  }
  if (argument === "--contract" && process.argv[index + 1]) {
    contractPath = path.resolve(process.argv[index + 1]);
    index += 1;
    continue;
  }
  fail(`unknown argument ${argument}`);
}

const { contract, releaseTagCount } = await validateMilestoneAcceptance({
  contract: contractPath ?? undefined,
});
if (requireReview) requireMaintainerApproval(contract);
if (requireRetainedInputs) validateRetainedHistoryInputs(repository);
console.log(
  `MILESTONE_ACCEPTANCE_OK task=A01 sources=${contract.history.sourceCount} tags=${releaseTagCount} review=${contract.maintainerReview.status}`
);
