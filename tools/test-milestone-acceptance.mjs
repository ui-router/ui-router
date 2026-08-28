#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  contractPath,
  repository,
  requireMaintainerApproval,
  validateRetainedHistoryInputs,
  validateMilestoneAcceptance,
} from "./milestone-acceptance-lib.mjs";

const original = JSON.parse(readFileSync(path.join(repository, contractPath), "utf8"));
const temporary = mkdtempSync(path.join(os.tmpdir(), "uirouter-a01-adversarial-"));
let cases = 0;

async function reject(name, mutate) {
  const candidate = structuredClone(original);
  mutate(candidate);
  const filename = path.join(temporary, `${String(cases).padStart(3, "0")}-${name}.json`);
  writeFileSync(filename, `${JSON.stringify(candidate, null, 2)}\n`);
  let rejected = false;
  try {
    await validateMilestoneAcceptance({ contract: filename });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`MILESTONE_ACCEPTANCE_TEST_FAILED: accepted ${name}`);
  cases += 1;
}

try {
  await validateMilestoneAcceptance();
  for (const field of Object.keys(original.bindings))
    await reject(`binding-${field}`, (candidate) => {
      candidate.bindings[field] = "0".repeat(64);
    });
  await reject("source-count", (candidate) => {
    candidate.history.sourceCount = 15;
  });
  await reject("tag-count", (candidate) => {
    candidate.history.releaseTagCount = 474;
  });
  await reject("c01-tree", (candidate) => {
    candidate.c01.tree = "0".repeat(40);
  });
  await reject("c02-tree", (candidate) => {
    candidate.c02.tree = "0".repeat(40);
  });
  await reject("retained-input-policy", (candidate) => {
    candidate.retainedInputs.tagFallback = "upstream";
  });
  await reject("acceptance-exception", (candidate) => {
    candidate.acceptance.exception.doesNotProve.pop();
  });
  await reject("acceptance-approver", (candidate) => {
    candidate.acceptance.approvedBy = "someone-else";
  });
  await reject("command-omission", (candidate) => {
    candidate.requiredCommands.pop();
  });
  await reject("review-issue", (candidate) => {
    candidate.maintainerReview.items[1].trackingIssue = "https://github.com/ui-router/ui-router/issues/999";
  });
  await reject("review-expiry", (candidate) => {
    candidate.maintainerReview.items[2].expires = "2027-01-01";
  });
  let pendingRejected = false;
  const pending = structuredClone(original);
  pending.maintainerReview.status = "pending";
  try {
    requireMaintainerApproval(pending);
  } catch {
    pendingRejected = true;
  }
  if (!pendingRejected) throw new Error("MILESTONE_ACCEPTANCE_TEST_FAILED: accepted pending review");
  cases += 1;
  const approved = structuredClone(original);
  approved.maintainerReview.status = "approved";
  requireMaintainerApproval(approved);
  cases += 1;
  let missingRetainedInputsRejected = false;
  try {
    validateRetainedHistoryInputs(temporary);
  } catch {
    missingRetainedInputsRejected = true;
  }
  if (!missingRetainedInputsRejected)
    throw new Error("MILESTONE_ACCEPTANCE_TEST_FAILED: accepted missing retained history inputs");
  cases += 1;
  console.log(`MILESTONE_ACCEPTANCE_ADVERSARIAL_OK cases=${cases}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
