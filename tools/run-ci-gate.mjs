#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
function fail(message) {
  throw new Error(`CI_GATE_FAILED: ${message}`);
}
function value(name) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1)
    if (process.argv[index] === name) values.push(process.argv[index + 1]);
  if (values.length !== 1) fail(`${name} must appear exactly once`);
  return values[0];
}
const known = new Set(["--job", "--shard"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (
    !known.has(argument) ||
    !process.argv[index + 1] ||
    process.argv[index + 1].startsWith("--")
  )
    fail(`unknown or incomplete argument ${argument}`);
  index += 1;
}
const jobId = value("--job");
const shardArgument = process.argv.includes("--shard")
  ? value("--shard")
  : null;
const contract = JSON.parse(
  readFileSync(path.join(repository, "migration/ci-gates.json"), "utf8")
);
let commands;
let resultId;
if (jobId === "integration") {
  if (!shardArgument) fail("integration requires --shard");
  const shard = contract.integration.shards.find(
    (candidate) => candidate.id === shardArgument
  );
  if (!shard) fail(`unknown integration shard ${shardArgument}`);
  commands = shard.commands;
  resultId = `integration-${shard.id}`;
} else {
  if (shardArgument) fail("--shard is integration-only");
  const job = contract.jobs.find((candidate) => candidate.id === jobId);
  if (!job) fail(`unknown job ${jobId}`);
  commands = job.commands;
  resultId = job.id;
}
if (!/^[a-z0-9-]+$/.test(resultId)) fail("unsafe result id");
const output = path.join(repository, ".ci-results", resultId);
let current = path.parse(output).root;
for (const component of path.relative(current, output).split(path.sep)) {
  if (!component) continue;
  current = path.join(current, component);
  if (existsSync(current) && lstatSync(current).isSymbolicLink())
    fail(`linked output component ${current}`);
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const gitStatus = () => {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: repository, encoding: "utf8" }
  );
  if (result.status !== 0) fail("cannot inspect tracked repository state");
  return result.stdout;
};
const github = process.env.GITHUB_ACTIONS === "true";
if (gitStatus() && (github || process.env.CI_GATE_ALLOW_DIRTY !== "1"))
  fail("tracked repository state is dirty before the gate");

const environment = {
  ...process.env,
  TURBO_TELEMETRY_DISABLED: "1",
  NO_COLOR: "1",
};
delete environment.NODE_PATH;
delete environment.TURBO_TOKEN;
delete environment.TURBO_TEAM;
for (const key of Object.keys(environment))
  if (key.toLowerCase().startsWith("npm_config_")) delete environment[key];

const maxLogBytes = 2 * 1024 * 1024;
function appendTail(currentValue, chunk) {
  const next = Buffer.concat([currentValue, Buffer.from(chunk)]);
  return next.length <= maxLogBytes
    ? next
    : next.subarray(next.length - maxLogBytes);
}
let active = null;
function stopActive(signal = "SIGTERM") {
  if (!active?.pid) return;
  try {
    process.kill(-active.pid, signal);
  } catch {
    // The process may already have exited.
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    stopActive(signal);
    process.exitCode = 128;
  });

const summary = {
  schemaVersion: 1,
  job: jobId,
  shard: shardArgument,
  status: "running",
  runtime: { node: process.version.slice(1), architecture: process.arch },
  commands: [],
};
function writeSummary() {
  const target = path.join(output, "summary.json");
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
  renameSync(temporary, target);
}
async function runCommand(command) {
  const started = Date.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let timedOut = false;
  const child = spawn(command.argv[0], command.argv.slice(1), {
    cwd: repository,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  active = child;
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdout = appendTail(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderr = appendTail(stderr, chunk);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    stopActive("SIGTERM");
    setTimeout(() => stopActive("SIGKILL"), 5_000).unref();
  }, command.timeoutMinutes * 60_000);
  const result = await new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({ status: null, signal: null, error })
    );
    child.once("exit", (status, signal) =>
      resolve({ status, signal, error: null })
    );
  });
  clearTimeout(timer);
  active = null;
  const record = {
    id: command.id,
    argv: command.argv,
    status: result.status,
    signal: result.signal,
    timedOut,
    durationMs: Date.now() - started,
  };
  summary.commands.push(record);
  if (result.error || timedOut || result.status !== 0) {
    writeFileSync(path.join(output, `${command.id}.stdout.log`), stdout);
    writeFileSync(path.join(output, `${command.id}.stderr.log`), stderr);
    summary.status = "failed";
    summary.failure =
      result.error?.message ??
      (timedOut ? "timeout" : `exit ${result.status ?? result.signal}`);
    writeSummary();
    fail(`${resultId}/${command.id} failed: ${summary.failure}`);
  }
  if (gitStatus() && (github || process.env.CI_GATE_ALLOW_DIRTY !== "1")) {
    summary.status = "failed";
    summary.failure = `tracked files changed after ${command.id}`;
    writeSummary();
    fail(summary.failure);
  }
  writeSummary();
}

try {
  for (const command of commands) await runCommand(command);
  summary.status = "passed";
  writeSummary();
  console.log(
    `CI_GATE_OK job=${jobId}${
      shardArgument ? ` shard=${shardArgument}` : ""
    } commands=${commands.length}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  stopActive("SIGTERM");
}
