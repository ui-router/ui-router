#!/usr/bin/env node

import crypto from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const workRoot = path.join(repository, ".ci-work");
const stage = path.join(workRoot, "browser");
const statePath = path.join(workRoot, "browser-state.json");
const archivePath = path.join(workRoot, "browser.tar");
const output = path.join(
  repository,
  ".ci-results/browser/workspace-browser.json"
);
const phases = ["install", "build", "setup", "e2e", "cleanup"];
function fail(message) {
  throw new Error(`CI_WORKSPACE_BROWSER_FAILED: ${message}`);
}
if (process.argv.length !== 4 || process.argv[2] !== "--phase")
  fail("usage: run-workspace-browser.mjs --phase <phase>");
const phase = process.argv[3];
if (!phases.includes(phase)) fail(`unknown phase ${phase}`);
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const contractSha256 = sha256(
  readFileSync(path.join(repository, "migration/ci-gates.json"))
);
function run(command, argv, cwd = stage) {
  const result = spawnSync(command, argv, {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0)
    fail(
      `${phase} command ${[command, ...argv].join(" ")} exited ${result.status}`
    );
}
function revision() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  });
  if (result.status !== 0) fail("cannot resolve repository revision");
  return result.stdout.trim();
}
let state;
if (phase === "install") {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run(
    "git",
    ["archive", "--format=tar", "HEAD", "-o", archivePath],
    repository
  );
  run("tar", ["-xf", archivePath, "-C", stage], repository);
  rmSync(archivePath);
  state = {
    schemaVersion: 1,
    revision: revision(),
    ciContractSha256: contractSha256,
    completedPhases: [],
    commands: [],
  };
} else {
  state = JSON.parse(readFileSync(statePath, "utf8"));
  if (
    state.revision !== revision() ||
    state.ciContractSha256 !== contractSha256 ||
    JSON.stringify(state.completedPhases) !==
      JSON.stringify(phases.slice(0, phases.indexOf(phase)))
  )
    fail("browser staging state is stale or out of order");
}
const commands = {
  install: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
  build: ["npm", "run", "build", "--", "--cache=local:"],
  setup: [
    "npm",
    "run",
    "setup:browser",
    "--",
    "--concurrency=1",
    "--cache=local:",
  ],
  e2e: ["npm", "run", "e2e", "--", "--concurrency=1", "--cache=local:"],
};
if (phase === "setup") run("node", ["tools/prepare-workspace-browser.mjs"]);
if (phase !== "cleanup") {
  const [command, ...argv] = commands[phase];
  run(command, argv);
  state.commands.push({ phase, argv: [command, ...argv], status: "passed" });
} else {
  run("node", ["tools/prepare-workspace-browser.mjs", "--cleanup"]);
}
state.completedPhases.push(phase);
mkdirSync(path.dirname(statePath), { recursive: true });
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
if (phase === "cleanup") {
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ ...state, status: "passed" }, null, 2)}\n`
  );
  renameSync(temporary, output);
  rmSync(workRoot, { recursive: true, force: true });
}
console.log(`CI_WORKSPACE_BROWSER_OK phase=${phase}`);
