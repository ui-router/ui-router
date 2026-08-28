#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  contractPath,
  repository,
  validateC01FinalHeadReview,
} from "./c01-final-head-review-lib.mjs";

const original = JSON.parse(readFileSync(path.join(repository, contractPath), "utf8"));
const temporary = mkdtempSync(path.join(os.tmpdir(), "uirouter-c01-final-head-review-"));
let cases = 0;

async function reject(name, mutate) {
  const candidate = structuredClone(original);
  mutate(candidate);
  const filename = path.join(temporary, `${String(cases).padStart(3, "0")}-${name}.json`);
  writeFileSync(filename, `${JSON.stringify(candidate, null, 2)}\n`);
  let rejected = false;
  try {
    await validateC01FinalHeadReview({ contract: filename });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`C01_FINAL_HEAD_REVIEW_TEST_FAILED: accepted ${name}`);
  cases += 1;
}

try {
  await validateC01FinalHeadReview();
  await reject("final-tree", (candidate) => {
    candidate.finalHead.tree = "0".repeat(40);
  });
  await reject("post-ready-commit", (candidate) => {
    candidate.postReadyFixes[2].commit = "0".repeat(40);
  });
  await reject("post-ready-files", (candidate) => {
    candidate.postReadyFixes[3].files.pop();
  });
  await reject("independent-review", (candidate) => {
    candidate.independentReview.reviewer = "someone-else";
  });
  await reject("maintainer-approval", (candidate) => {
    candidate.maintainerApproval.approvedBy = "someone-else";
  });
  console.log(`C01_FINAL_HEAD_REVIEW_ADVERSARIAL_OK cases=${cases}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
