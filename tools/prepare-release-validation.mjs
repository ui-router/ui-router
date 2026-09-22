#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createReleaseVersionPlan, releaseVersionPlanPath } from './release-version-plan.mjs';

const root = path.resolve(import.meta.dirname, '..');
try {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      package: { type: 'string', multiple: true, default: [] },
      write: { type: 'boolean', default: false },
    },
  });
  if (!values.base)
    throw new Error(
      'usage: node tools/prepare-release-validation.mjs --base <full-preparation-base-commit> [--package <name>] [--write]',
    );
  const plan = createReleaseVersionPlan(root, values.base, values.package);
  const text = JSON.stringify(plan, null, 2) + '\n';
  if (values.write) {
    mkdirSync(path.join(root, path.dirname(releaseVersionPlanPath)), { recursive: true });
    writeFileSync(path.join(root, releaseVersionPlanPath), text);
    console.log(
      `RELEASE_VERSION_PLAN_WRITTEN ${releaseVersionPlanPath}; review with the prepared manifests and changelogs; fresh package/consumer proofs are still required`,
    );
  } else process.stdout.write(text);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
