#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  contractPath,
  repository,
  validateCiGates,
  workflowPath,
} from "./ci-gates-lib.mjs";

const original = JSON.parse(
  readFileSync(path.join(repository, contractPath), "utf8")
);
const originalWorkflow = readFileSync(
  path.join(repository, workflowPath),
  "utf8"
);
const temporary = mkdtempSync(
  path.join(os.tmpdir(), "uirouter-c01-adversarial-")
);
let cases = 0;
function clone() {
  return structuredClone(original);
}
async function rejectContract(name, mutate) {
  const candidate = clone();
  mutate(candidate);
  const filename = path.join(
    temporary,
    `${String(cases).padStart(3, "0")}-${name}.json`
  );
  writeFileSync(filename, `${JSON.stringify(candidate, null, 2)}\n`);
  let rejected = false;
  try {
    await validateCiGates({ contract: filename });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`CI_GATES_TEST_FAILED: accepted ${name}`);
  cases += 1;
}
function rejectWorkflow(name, mutate) {
  const candidate = mutate(originalWorkflow);
  const filename = path.join(
    temporary,
    `${String(cases).padStart(3, "0")}-${name}.yml`
  );
  writeFileSync(filename, candidate);
  const result = spawnSync(
    process.execPath,
    [
      path.join(repository, "tools/verify-ci-gates.mjs"),
      "--workflow",
      filename,
    ],
    {
      cwd: repository,
      encoding: "utf8",
    }
  );
  if (result.status === 0)
    throw new Error(`CI_GATES_TEST_FAILED: accepted workflow ${name}`);
  cases += 1;
}
try {
  await validateCiGates();
  const bindings = Object.keys(original.bindings);
  for (const field of bindings)
    await rejectContract(`binding-${field}`, (candidate) => {
      candidate.bindings[field] = "0".repeat(64);
    });
  await rejectContract("schema-version", (c) => {
    c.schemaVersion = 2;
  });
  await rejectContract("owner", (c) => {
    c.owner = "";
  });
  await rejectContract("mutable-image", (c) => {
    c.runtime.ciImage = "mcr.microsoft.com/playwright:latest";
  });
  await rejectContract("image-digest", (c) => {
    c.runtime.ciImageDigest = `sha256:${"1".repeat(64)}`;
  });
  await rejectContract("node", (c) => {
    c.runtime.node = "24.18.1";
  });
  await rejectContract("npm", (c) => {
    c.runtime.npm = "11.16.0";
  });
  await rejectContract("npm-provisioning", (c) => {
    c.runtime.npmInstallCommand[3] = "npm@latest";
  });
  await rejectContract("turbo", (c) => {
    c.runtime.turbo = "2.10.11";
  });
  await rejectContract("browser-sha", (c) => {
    c.runtime.browser.executableSha256 = "2".repeat(64);
  });
  await rejectContract("environment", (c) => {
    c.runtime.environment.CI = "0";
  });
  await rejectContract("action-sha", (c) => {
    c.actions.checkout.sha = "3".repeat(40);
  });
  await rejectContract("action-version", (c) => {
    c.actions.uploadArtifact.version = "latest";
  });
  await rejectContract("gate-omission", (c) => {
    c.gateIds.pop();
  });
  await rejectContract("gate-duplicate", (c) => {
    c.gateIds[1] = c.gateIds[0];
  });
  await rejectContract("job-omission", (c) => {
    c.jobs.pop();
  });
  await rejectContract("job-order", (c) => {
    c.jobs.reverse();
  });
  await rejectContract("command-omission", (c) => {
    c.jobs[0].commands.pop();
  });
  await rejectContract("command-substitution", (c) => {
    c.jobs[0].commands[2].argv = ["true"];
  });
  await rejectContract("install-scripts", (c) => {
    c.jobs[0].commands[1].argv = ["npm", "ci"];
  });
  await rejectContract("npm-install", (c) => {
    c.jobs[1].commands[1].argv = ["npm", "install"];
  });
  await rejectContract("force", (c) => {
    c.jobs[1].commands[2].argv.push("--force");
  });
  await rejectContract("legacy-peer", (c) => {
    c.jobs[2].commands[1].argv.push("--legacy-peer-deps");
  });
  await rejectContract("source-cache", (c) => {
    c.jobs[1].commands[2].argv.pop();
  });
  await rejectContract("package-producer", (c) => {
    c.jobs[2].commands[2].argv = ["true"];
  });
  await rejectContract("package-stage", (c) => {
    c.jobs[2].commands[3].argv[3] = ".ci-artifacts/other";
  });
  await rejectContract("browser-build-cache", (c) => {
    c.jobs[3].commands[2].argv.pop();
  });
  await rejectContract("browser-setup", (c) => {
    c.jobs[3].commands[3].argv[4] = "--concurrency=2";
  });
  await rejectContract("docs-execution", (c) => {
    c.jobs[4].commands.push({
      id: "docs",
      argv: ["npm", "run", "docs"],
      timeoutMinutes: 1,
    });
  });
  await rejectContract("shard-project-omission", (c) => {
    c.integration.shards[0].projectIds.pop();
  });
  await rejectContract("shard-project-duplicate", (c) => {
    c.integration.shards[0].projectIds.push(
      c.integration.shards[0].projectIds[0]
    );
  });
  await rejectContract("shard-project-extra", (c) => {
    c.integration.shards[0].projectIds.push("unknown/project");
  });
  await rejectContract("shard-runner-output", (c) => {
    c.integration.shards[0].commands[2].argv[7] = ".migration-work/i02/wrong";
  });
  await rejectContract("shard-artifacts", (c) => {
    c.integration.shards[0].commands[2].argv.splice(8, 2);
  });
  await rejectContract("shard-verifier", (c) => {
    c.integration.shards[0].commands[3].argv = ["true"];
  });
  await rejectContract("aggregate-need", (c) => {
    c.aggregate.needs.pop();
  });
  await rejectContract("aggregate-result", (c) => {
    c.aggregate.requireResult = "completed";
  });
  await rejectContract("artifact-omission", (c) => {
    c.artifacts.packages.artifactIds.pop();
  });
  await rejectContract("artifact-extra", (c) => {
    c.artifacts.packages.artifactIds.push("extra");
  });
  await rejectContract("integration-artifact", (c) => {
    c.artifacts.packages.integrationArtifactIds.pop();
  });
  await rejectContract("artifact-compression", (c) => {
    c.artifacts.packages.compressionLevel = 6;
  });
  await rejectContract("browser-workspace", (c) => {
    c.browserWorkspaces.pop();
  });
  await rejectContract("docs-waiver-omission", (c) => {
    c.docsWaivers.pop();
  });
  await rejectContract("docs-waiver-expiry", (c) => {
    c.docsWaivers[0].waiver.expires = "2000-01-01";
  });
  await rejectContract("docs-waiver-evidence", (c) => {
    c.docsWaivers[0].evidence.sha256 = "4".repeat(64);
  });
  await rejectContract("current-waiver-omission", (c) => {
    c.currentWaivers = [];
  });
  await rejectContract("current-waiver-expiry", (c) => {
    c.currentWaivers[0].expires = "2000-01-01";
  });
  await rejectContract("current-waiver-issue", (c) => {
    c.currentWaivers[0].trackingIssue = "https://example.invalid/issue";
  });
  await rejectContract("baseline-omission", (c) => {
    c.baselineCoverage.pop();
  });
  await rejectContract("baseline-duplicate", (c) => {
    c.baselineCoverage[1].baselineId = c.baselineCoverage[0].baselineId;
  });
  await rejectContract("baseline-disposition", (c) => {
    c.baselineCoverage[0].disposition = "historical-only";
  });
  await rejectContract("baseline-gate", (c) => {
    c.baselineCoverage[0].gateIds = ["docs"];
  });
  await rejectContract("derived-count", (c) => {
    c.counts.sourceEdges = 18;
  });
  await rejectContract("remote-cache", (c) => {
    c.runtime.environment.TURBO_TOKEN = "forbidden";
  });

  rejectWorkflow("mutable-action", (text) =>
    text.replace(original.actions.checkout.sha, "actions/checkout@v4")
  );
  rejectWorkflow("image-tag", (text) =>
    text.replace(
      original.runtime.ciImage,
      "mcr.microsoft.com/playwright:latest"
    )
  );
  rejectWorkflow("missing-required", (text) =>
    text.replace("  required:\n", "  omitted:\n")
  );
  rejectWorkflow("missing-always", (text) =>
    text.replace("    if: always()\n", "")
  );
  rejectWorkflow("continue-on-error", (text) =>
    text.replace(
      "    timeout-minutes: 90\n",
      "    timeout-minutes: 90\n    continue-on-error: true\n"
    )
  );
  rejectWorkflow("cache-action", (text) =>
    text.replace(
      "      - name: Run source gate\n",
      "      - uses: actions/cache@v4\n      - name: Run source gate\n"
    )
  );
  rejectWorkflow("npm-provisioning", (text) =>
    text.replace("npm@11.17.0", "npm@latest")
  );
  rejectWorkflow("artifact-name", (text) =>
    text.replace(original.workflow.packageArtifactName, "packages-unbound")
  );
  rejectWorkflow("download-omission", (text) =>
    text.replace(
      `actions/download-artifact@${original.actions.downloadArtifact.sha}`,
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"
    )
  );
  rejectWorkflow("aggregate-bypass", (text) =>
    text.replace(
      'test "${{ needs.docs.result }}" = "success"',
      'test "success" = "success"'
    )
  );
  rejectWorkflow("unreviewed-trigger", (text) =>
    text.replace("  pull_request:\n", "  pull_request_target:\n")
  );

  console.log(`CI_GATES_ADVERSARIAL_OK cases=${cases}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
