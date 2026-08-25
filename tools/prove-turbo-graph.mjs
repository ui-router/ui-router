#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const aliases = JSON.parse(
  readFileSync(path.join(root, "migration/source-aliases.json"), "utf8")
);
const turboBinary = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "turbo.cmd" : "turbo"
);
const cacheDirectory = ".turbo/s03-proof-cache";
const restorations = [];

function fail(message) {
  throw new Error(`TURBO_GRAPH_PROOF_FAILED: ${message}`);
}

function restoreAll() {
  while (restorations.length) {
    try {
      restorations.pop()();
    } catch {
      // Preserve the first proof failure; all restoration actions are best effort here.
    }
  }
}
process.on("SIGINT", () => {
  restoreAll();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreAll();
  process.exit(143);
});

function turbo(args, { capture = true } = {}) {
  const result = spawnSync(turboBinary, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", TURBO_TELEMETRY_DISABLED: "1" },
    maxBuffer: 128 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    fail(
      `turbo ${args.join(" ")} exited ${result.status}:\n${
        result.stderr || result.stdout || ""
      }`
    );
  }
  return result.stdout || "";
}

function dryTasks(packageName, taskNames) {
  const output = turbo([
    "run",
    ...taskNames,
    `--filter=${packageName}`,
    "--dry=json",
    `--cache-dir=${cacheDirectory}`,
  ]);
  const summary = JSON.parse(output);
  return new Map(summary.tasks.map((task) => [task.taskId, task]));
}

function packageNameForConsumer(consumer) {
  return JSON.parse(readFileSync(path.join(root, consumer), "utf8")).name;
}

function trackedStatus() {
  const result = spawnSync(
    "git",
    ["status", "--short", "--untracked-files=no"],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    }
  );
  if (result.status !== 0) fail(`git status failed: ${result.stderr}`);
  return result.stdout;
}

function cacheCounts(output) {
  const match = output.match(/Cached:\s+(\d+) cached,\s+(\d+) total/u);
  if (!match) fail(`Turbo output omitted cache summary:\n${output}`);
  return { cached: Number(match[1]), total: Number(match[2]) };
}

const installedValidation = spawnSync(
  process.execPath,
  ["tools/verify-turbo-graph.mjs", "--installed"],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
    maxBuffer: 128 * 1024 * 1024,
  }
);
if (installedValidation.status !== 0) {
  fail(
    `installed Turbo graph validation failed:\n${
      installedValidation.stderr || installedValidation.stdout || ""
    }`
  );
}
if (!installedValidation.stdout.includes("installedGraph=validated")) {
  fail("installed Turbo graph validation was not executed");
}

const initialStatus = trackedStatus();
let sourceMutations = 0;
try {
  for (const edge of aliases.edges) {
    const packageName = packageNameForConsumer(edge.consumer);
    const tasks = ["test", "test:watch"];
    if (packageName === "@uirouter/angularjs") tasks.push("typecheck");
    const before = dryTasks(packageName, tasks);
    const sourcePath = path.join(root, edge.sourceEntrypoint);
    const original = readFileSync(sourcePath);
    const restore = () => writeFileSync(sourcePath, original);
    restorations.push(restore);
    writeFileSync(
      sourcePath,
      Buffer.concat([
        original,
        Buffer.from("\n// s03-turbo-source-invalidation-proof\n"),
      ])
    );
    const after = dryTasks(packageName, tasks);
    for (const taskName of tasks) {
      const taskId = `${packageName}#${taskName}`;
      const beforeTask = before.get(taskId);
      const afterTask = after.get(taskId);
      if (!beforeTask || !afterTask)
        fail(`${edge.id}: Turbo omitted ${taskId}`);
      if (beforeTask.hash === afterTask.hash)
        fail(`${edge.id}: ${taskId} hash ignored ${edge.sourceEntrypoint}`);
    }
    restore();
    restorations.pop();
    sourceMutations += 1;
  }

  const generatedEdge = aliases.edges[0];
  const generatedPackage = packageNameForConsumer(generatedEdge.consumer);
  const generatedTaskId = `${generatedPackage}#test`;
  const generatedBefore = dryTasks(generatedPackage, ["test"]).get(
    generatedTaskId
  );
  const generatedDirectory = path.join(root, generatedEdge.ignoredPaths[0]);
  const directoryExisted = existsSync(generatedDirectory);
  mkdirSync(generatedDirectory, { recursive: true });
  const sentinel = path.join(
    generatedDirectory,
    ".s03-turbo-generated-output-proof"
  );
  if (existsSync(sentinel))
    fail(`${path.relative(root, sentinel)} already exists`);
  const removeSentinel = () => {
    rmSync(sentinel, { force: true });
    if (!directoryExisted)
      rmSync(generatedDirectory, { recursive: true, force: true });
  };
  restorations.push(removeSentinel);
  writeFileSync(
    sentinel,
    "generated output must not invalidate source tests\n"
  );
  const generatedAfter = dryTasks(generatedPackage, ["test"]).get(
    generatedTaskId
  );
  if (!generatedBefore || !generatedAfter)
    fail(`Turbo omitted ${generatedTaskId} during generated-output proof`);
  if (generatedBefore.hash !== generatedAfter.hash) {
    fail(
      `${generatedTaskId} hash consumed generated path ${generatedEdge.ignoredPaths[0]}`
    );
  }
  removeSentinel();
  restorations.pop();

  const cachedPackages = [
    ...new Set(
      aliases.edges.map((edge) => packageNameForConsumer(edge.consumer))
    ),
  ].sort();
  if (cachedPackages.length !== 7)
    fail(
      `expected 7 cache-eligible source consumers, found ${cachedPackages.length}`
    );
  const executionArgs = [
    "run",
    "test",
    "typecheck",
    ...cachedPackages.map((packageName) => `--filter=${packageName}`),
    "--concurrency=2",
    "--output-logs=errors-only",
    `--cache-dir=${cacheDirectory}`,
  ];

  for (let run = 1; run <= 2; run += 1) {
    const output = turbo([...executionArgs, "--force"]);
    const counts = cacheCounts(output);
    if (counts.cached !== 0 || counts.total !== 8) {
      fail(
        `forced deterministic run ${run} expected 0/8 cached tasks, got ${counts.cached}/${counts.total}`
      );
    }
  }

  rmSync(path.join(root, cacheDirectory), { recursive: true, force: true });
  const coldOutput = turbo(executionArgs);
  const cold = cacheCounts(coldOutput);
  if (cold.cached !== 0 || cold.total !== 8)
    fail(`cold cache run expected 0/8, got ${cold.cached}/${cold.total}`);
  if (!coldOutput.includes("Remote caching disabled"))
    fail("cold run did not explicitly report remote caching disabled");

  const warmOutput = turbo(executionArgs);
  const warm = cacheCounts(warmOutput);
  if (warm.cached !== 8 || warm.total !== 8)
    fail(`warm cache run expected 8/8, got ${warm.cached}/${warm.total}`);
  if (!warmOutput.includes("FULL TURBO"))
    fail("warm run did not report a full local Turbo cache hit");

  const finalStatus = trackedStatus();
  if (finalStatus !== initialStatus)
    fail(`tracked repository state changed:\n${finalStatus}`);

  console.log(
    `TURBO_GRAPH_PROOF_OK sourceMutations=${sourceMutations} generatedOutputs=excluded forcedRuns=2 coldCache=0/8 warmCache=8/8 remoteCache=disabled`
  );
} finally {
  restoreAll();
}
