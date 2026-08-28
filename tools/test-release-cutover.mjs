#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  contractPath,
  repository,
  requirePlanApproval,
  validateReleaseCutoverPlan,
} from "./release-cutover-lib.mjs";

const original = JSON.parse(readFileSync(path.join(repository, contractPath), "utf8"));
const temporary = mkdtempSync(path.join(os.tmpdir(), "uirouter-r01-adversarial-"));
let cases = 0;

async function reject(name, mutate) {
  const candidate = structuredClone(original);
  mutate(candidate);
  const filename = path.join(temporary, `${String(cases).padStart(3, "0")}-${name}.json`);
  writeFileSync(filename, `${JSON.stringify(candidate, null, 2)}\n`);
  let rejected = false;
  try {
    await validateReleaseCutoverPlan({ contract: filename });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`RELEASE_CUTOVER_PLAN_TEST_FAILED: accepted ${name}`);
  cases += 1;
}

try {
  await validateReleaseCutoverPlan();
  for (const field of Object.keys(original.bindings))
    await reject(`binding-${field}`, (candidate) => {
      candidate.bindings[field] = "0".repeat(64);
    });
  await reject("a01-tree", (candidate) => {
    candidate.a01.tree = "0".repeat(40);
  });
  await reject("source-omission", (candidate) => {
    candidate.sourceRepositories.names.pop();
    candidate.sourceRepositories.count = 15;
  });
  await reject("package-version-drift", (candidate) => {
    candidate.releaseInventory.packages[0].version = "9.9.9";
  });
  await reject("forbidden-action-omission", (candidate) => {
    candidate.scope.forbiddenActions.pop();
  });
  await reject("live-phase", (candidate) => {
    candidate.phases[2].mode = "execute-now";
  });
  await reject("unknown-gate", (candidate) => {
    candidate.phases[0].requires = ["publish-now"];
  });
  await reject("decision-gate-order", (candidate) => {
    candidate.decisionGates.reverse();
  });
  let awaitingApprovalRejected = false;
  try {
    requirePlanApproval(original);
  } catch {
    awaitingApprovalRejected = true;
  }
  if (!awaitingApprovalRejected)
    throw new Error("RELEASE_CUTOVER_PLAN_TEST_FAILED: accepted unapproved plan");
  cases += 1;
  const approved = structuredClone(original);
  approved.status = "approved";
  requirePlanApproval(approved);
  cases += 1;
  console.log(`RELEASE_CUTOVER_PLAN_ADVERSARIAL_OK cases=${cases}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
