#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createReleaseVersionPlan, releaseVersionPlanPath } from './release-version-plan.mjs';

const root = path.resolve(import.meta.dirname, '..');
try {
  const args = process.argv.slice(2);
  const write = args.at(-1) === '--write';
  if (write) args.pop();
  if (args.length !== 2 || args[0] !== '--base')
    throw new Error('usage: node tools/prepare-release-validation.mjs --base <full-preparation-base-commit> [--write]');
  const plan = createReleaseVersionPlan(root, args[1]);
  const text = JSON.stringify(plan, null, 2) + '\n';
  if (write) {
    mkdirSync(path.join(root, path.dirname(releaseVersionPlanPath)), { recursive: true });
    writeFileSync(path.join(root, releaseVersionPlanPath), text);
    console.log(
      `RELEASE_VERSION_PLAN_WRITTEN ${releaseVersionPlanPath}; review with the prepared manifests and changelogs; fresh package/consumer proofs are still required`
    );
  } else process.stdout.write(text);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
