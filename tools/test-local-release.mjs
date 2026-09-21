import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const release = path.join(root, "tools/publish-scripts/release.js");
const fixture = () =>
  mkdtempSync(path.join(os.tmpdir(), "uirouter-release-test-"));
function write(dir, name, value) {
  const target = path.join(dir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    typeof value === "string" ? value : JSON.stringify(value)
  );
}
function git(dir, ...args) {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}
function snapshot(dir) {
  const hash = createHash("sha256");
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      if (entry.name === ".git") continue;
      const file = path.join(current, entry.name);
      hash.update(path.relative(dir, file));
      if (entry.isDirectory()) walk(file);
      else hash.update(readFileSync(file));
    }
  }
  walk(dir);
  return [
    hash.digest("hex"),
    git(dir, "show-ref"),
    git(dir, "status", "--porcelain"),
  ];
}
function run(cwd, args) {
  return spawnSync(process.execPath, [release, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15000,
  });
}

test("preview uses imported paths, filters history, handles versions, and cannot write or publish", () => {
  const dir = fixture();
  try {
    git(dir, "init", "--initial-branch=main");
    git(dir, "config", "user.name", "Release test");
    git(dir, "config", "user.email", "release-test@example.invalid");
    write(dir, "historical/package.json", {
      name: "@uirouter/demo",
      version: "1.2.3",
    });
    git(dir, "add", ".");
    git(dir, "commit", "-m", "initial");
    git(dir, "tag", "demo@1.2.3");
    git(dir, "tag", "other@99.0.0");
    write(dir, "package.json", { private: true });
    write(dir, "package-lock.json", { lockfileVersion: 3 });
    write(dir, "packages/demo/package.json", {
      name: "@uirouter/demo",
      version: "1.2.3",
    });
    write(dir, "packages/demo/CHANGELOG.md", "existing changelog");
    write(dir, "packages/demo/typedoc.json", {});
    write(dir, "migration/package-artifacts.json", {
      packages: [
        {
          id: "demo",
          package: "@uirouter/demo",
          manifest: "packages/demo/package.json",
          pack: { directory: "dist" },
        },
      ],
    });
    write(dir, "migration/sources.json", {
      sources: [
        {
          name: "demo",
          destinationPrefix: "historical",
          tagNamespace: "demo@",
          releaseTags: [{ targetName: "demo@1.2.3" }],
        },
      ],
    });
    git(dir, "add", ".");
    git(dir, "commit", "-m", "feat: move package");
    write(dir, "unrelated.txt", "unrelated");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "unrelated change");
    write(dir, "dirty.txt", "retain me");
    const before = snapshot(dir);
    const cwd = path.join(dir, "packages/demo");
    for (const [flag, bump, expected] of [
      ["--dry-run", "patch", "1.2.4"],
      ["--dryrun", "minor", "1.3.0"],
      ["-d", "major", "2.0.0"],
      ["--dry-run", "none", "1.2.3"],
    ]) {
      const result = run(cwd, [
        flag,
        "--bump",
        bump,
        "--deps",
        "@uirouter/core",
        "--legacy-angularjs",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const preview = JSON.parse(result.stdout);
      assert.equal(preview.proposedVersion, expected);
      assert.equal(preview.proposedTag, `demo@${expected}`);
      assert.equal(preview.tagAlreadyExists, bump === "none");
      assert.equal(preview.previousTag, "demo@1.2.3");
      assert.equal(preview.previousManifest, "historical/package.json");
      assert.equal(preview.previousVersion, "1.2.3");
      assert.equal(preview.publishDirectory, "packages/demo/dist");
      assert.equal(preview.dirty, true);
      assert.ok(
        preview.commits.some((item) => item.endsWith("feat: move package"))
      );
      assert.ok(
        preview.commits.every((item) => !item.endsWith("unrelated change"))
      );
      assert.match(preview.legacyAngularjsFollowOns, /skipped/);
      assert.deepEqual(snapshot(dir), before);
    }
    const blocked = run(cwd, []);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Live monorepo releases are not implemented/);
    assert.equal(run(cwd, ["--dry-run", "--bump", "invalid"]).status, 1);
    assert.equal(run(dir, ["--dry-run"]).status, 1);
    assert.deepEqual(snapshot(dir), before);
    git(dir, "tag", "-d", "demo@1.2.3");
    const firstRelease = JSON.parse(run(cwd, ["--dry-run"]).stdout);
    assert.equal(firstRelease.previousTag, null);
    assert.equal(firstRelease.previousManifest, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all twelve real npm release commands forward dry-run flags without altering tracked files or tags", () => {
  const inventory = JSON.parse(
    readFileSync(path.join(root, "migration/package-artifacts.json"))
  ).packages;
  const before = [
    git(root, "diff", "HEAD", "--binary"),
    git(root, "status", "--porcelain"),
    git(root, "show-ref"),
  ];
  for (const record of inventory) {
    const result = spawnSync(
      "npm",
      ["run", "--silent", "release", "--", "--dry-run", "--bump", "patch"],
      {
        cwd: path.dirname(path.join(root, record.manifest)),
        encoding: "utf8",
        timeout: 15000,
      }
    );
    assert.equal(result.status, 0, `${record.package}: ${result.stderr}`);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.package, record.package);
    assert.equal(preview.mode, "read-only-preview");
    assert.ok(preview.proposedTag.startsWith(`${record.id}@`));
    if (record.id === "angularjs")
      assert.match(preview.legacyAngularjsFollowOns, /skipped/);
  }
  assert.deepEqual(
    [
      git(root, "diff", "HEAD", "--binary"),
      git(root, "status", "--porcelain"),
      git(root, "show-ref"),
    ],
    before
  );
});
