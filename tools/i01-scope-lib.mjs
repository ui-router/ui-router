import { execFileSync, spawnSync } from "node:child_process";

export const I01_BASE_COMMIT = "d9707bdc6fb9df51d1447e4b806da9139fe55691";
export const I01_COMMIT_SUBJECT =
  "Finalize isolated compatibility project contract";
export const I01_CHANGED_FILES = new Map([
  ["migration/evidence/i01/install-proof.json", "A"],
  ["migration/evidence/i01/isolation-proof.json", "A"],
  ["migration/isolated-projects.json", "A"],
  ["migration/schemas/isolated-projects.schema.json", "A"],
  ["package.json", "M"],
  ["tools/i01-scope-lib.mjs", "A"],
  ["tools/prove-npm-installs.mjs", "M"],
  ["tools/test-isolated-projects.mjs", "A"],
  ["tools/verify-isolated-projects.mjs", "A"],
  ["tools/verify-package-manager.mjs", "M"],
]);
export const I01_IMMUTABLE_ARTIFACTS = [
  "migration/evidence/i01/install-proof.json",
  "migration/evidence/i01/isolation-proof.json",
  "migration/isolated-projects.json",
  "migration/schemas/isolated-projects.schema.json",
  "tools/i01-scope-lib.mjs",
  "tools/test-isolated-projects.mjs",
  "tools/verify-isolated-projects.mjs",
];

export function validateI01ChangedFiles(records) {
  const actual = new Map();
  for (const record of records) {
    if (
      !record ||
      typeof record.path !== "string" ||
      typeof record.status !== "string"
    ) {
      throw new Error("invalid I01 changed-file record");
    }
    if (actual.has(record.path))
      throw new Error(`duplicate I01 changed path: ${record.path}`);
    actual.set(record.path, record.status);
  }
  for (const [file, status] of I01_CHANGED_FILES) {
    if (!actual.has(file))
      throw new Error(`I01 change closure is missing ${status} ${file}`);
    if (actual.get(file) !== status) {
      throw new Error(
        `I01 change closure status for ${file} is ${actual.get(
          file
        )}, expected ${status}`
      );
    }
  }
  for (const [file, status] of actual) {
    if (!I01_CHANGED_FILES.has(file))
      throw new Error(
        `I01 change closure contains forbidden ${status} ${file}`
      );
  }
}

function git(root, args) {
  return execFileSync(
    "git",
    ["-c", `safe.directory=${root}`, "-C", root, ...args],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }
  ).trim();
}

export function hasGitRepository(root) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${root}`, "-C", root, "rev-parse", "--git-dir"],
    {
      encoding: "utf8",
    }
  );
  return result.status === 0;
}

export function verifyI01GitClosure(root) {
  git(root, ["cat-file", "-e", `${I01_BASE_COMMIT}^{commit}`]);
  const ancestry = git(root, [
    "rev-list",
    "--reverse",
    "--ancestry-path",
    `${I01_BASE_COMMIT}..HEAD`,
  ]);
  const commits = ancestry ? ancestry.split("\n") : [];
  const taskCommits = commits.filter(
    (commit) =>
      git(root, ["show", "-s", "--format=%s", commit]) === I01_COMMIT_SUBJECT
  );
  if (taskCommits.length !== 1) {
    throw new Error(
      `expected exactly one I01 task commit in base..HEAD, found ${taskCommits.length}`
    );
  }
  const taskCommit = taskCommits[0];
  const parents = git(root, ["show", "-s", "--format=%P", taskCommit])
    .split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 1 || parents[0] !== I01_BASE_COMMIT) {
    throw new Error(
      `I01 task commit must have only ${I01_BASE_COMMIT} as its parent`
    );
  }
  const output = git(root, [
    "diff",
    "--name-status",
    "--no-renames",
    I01_BASE_COMMIT,
    taskCommit,
  ]);
  const records = output
    ? output.split("\n").map((line) => {
        const [status, ...pathParts] = line.split("\t");
        return { status, path: pathParts.join("\t") };
      })
    : [];
  validateI01ChangedFiles(records);

  const currentDrift = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${root}`,
      "-C",
      root,
      "diff",
      "--quiet",
      taskCommit,
      "--",
      ...I01_IMMUTABLE_ARTIFACTS,
    ],
    { encoding: "utf8" }
  );
  if (currentDrift.status !== 0) {
    throw new Error(
      "current I01 artifacts differ from the immutable I01 task commit"
    );
  }
  return { taskCommit, records };
}
