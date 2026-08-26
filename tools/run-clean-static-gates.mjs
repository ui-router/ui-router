#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
let worktree;
let registered = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repository,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${
        result.stdout || ""
      }${result.stderr || ""}`
    );
  }
  return result.stdout;
}

try {
  const worktreeRoot = path.join(repository, ".migration-work");
  await mkdir(worktreeRoot, { recursive: true });
  worktree = await mkdtemp(path.join(worktreeRoot, "p01-static-"));
  await rm(worktree, { recursive: true, force: true });
  run("git", ["worktree", "add", "--detach", worktree, "HEAD"]);
  registered = true;
  const output = run("npm", ["run", "check:static"], { cwd: worktree });
  process.stdout.write(output);
  console.log("CLEAN_STATIC_GATES_OK source=detached-head-worktree");
} catch (error) {
  console.error(
    `CLEAN_STATIC_GATES_FAILED: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
} finally {
  if (registered) {
    spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: repository,
      encoding: "utf8",
    });
  }
  if (worktree) await rm(worktree, { recursive: true, force: true });
}
