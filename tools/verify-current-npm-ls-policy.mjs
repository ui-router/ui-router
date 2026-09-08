#!/usr/bin/env node

import path from "node:path";

import { loadCurrentNpmLsPolicy } from "./current-npm-ls-policy.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const policy = loadCurrentNpmLsPolicy(repository);
console.log(
  `CURRENT_NPM_LS_POLICY_OK baseline=${policy.baselineProblemCount} current=${policy.currentProblemCount} resolved=${policy.resolvedProblemCount} manifests=${policy.verifiedManifestCount}`
);
