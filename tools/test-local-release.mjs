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
import "./test-release-version-plan.mjs";

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
    const retired = run(cwd, ["--dry-run", "--bower"]);
    assert.equal(retired.status, 1);
    assert.match(retired.stderr, /Bower publishing is retired/);
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
    assert.deepEqual(
      preview.npmPackages,
      record.id === "angularjs"
        ? ["@uirouter/angularjs", "angular-ui-router"]
        : [record.package]
    );
    if (record.id === "angularjs") {
      assert.match(
        preview.legacyAngularjsFollowOns,
        /npm dual publish retained; skipped/
      );
    }
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

function preparationFixture() {
  const dir = fixture();
  git(dir, "init", "--initial-branch=release-test");
  git(dir, "config", "user.name", "Release test");
  git(dir, "config", "user.email", "release-test@example.invalid");
  write(dir, "historical/package.json", {
    name: "@uirouter/demo",
    version: "1.2.3",
  });
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  git(dir, "tag", "demo@1.2.3");
  write(dir, "historical/fix.txt", "fix");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fix: historical package fix");
  write(dir, "release/version-baseline.json", {
    schemaVersion: 1,
    sourceCommit: git(dir, "rev-parse", "HEAD"),
    publicationEvidence: [],
  });
  const manifests = {
    demo: {
      name: "@uirouter/demo",
      version: "1.2.3",
      scripts: {
        version:
          "node -e \"require('fs').writeFileSync('lifecycle-ran', 'bad')\"",
      },
    },
    client: {
      name: "@uirouter/client",
      version: "1.0.0",
      dependencies: { "@uirouter/demo": "1.2.3" },
    },
    app: {
      name: "private-app",
      version: "1.0.0",
      private: true,
      dependencies: { "@uirouter/client": "=1.0.0" },
    },
  };
  const rootManifest = {
    name: "release-fixture",
    version: "1.0.0",
    private: true,
    workspaces: ["packages/*"],
  };
  write(dir, "package.json", rootManifest);
  const packages = { "": rootManifest };
  for (const [id, manifest] of Object.entries(manifests)) {
    write(dir, `packages/${id}/package.json`, manifest);
    write(
      dir,
      `packages/${id}/CHANGELOG.md`,
      `# Previous ${id} release notes\n`
    );
    packages[`packages/${id}`] = JSON.parse(JSON.stringify(manifest));
    delete packages[`packages/${id}`].scripts;
    delete packages[`packages/${id}`].private;
    packages[`node_modules/${manifest.name}`] = {
      resolved: `packages/${id}`,
      link: true,
    };
  }
  write(dir, "package-lock.json", {
    name: rootManifest.name,
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages,
  });
  write(dir, "migration/package-artifacts.json", {
    packages: ["demo", "client"].map((id) => ({
      id,
      package: manifests[id].name,
      manifest: `packages/${id}/package.json`,
      pack: { directory: "." },
    })),
  });
  write(dir, "migration/sources.json", {
    sources: ["demo", "client"].map((id) => ({
      name: id,
      destinationPrefix: id === "demo" ? "historical" : `packages/${id}`,
      tagNamespace: `${id}@`,
      releaseTags: id === "demo" ? [{ targetName: "demo@1.2.3" }] : [],
    })),
  });
  git(dir, "add", ".");
  git(dir, "commit", "-m", "chore: move package");
  git(dir, "tag", "client@1.0.0");
  write(dir, "packages/demo/feature.txt", "feature");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "feat: scoped package feature");
  write(dir, "unrelated.txt", "other");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "fix: unrelated package change");
  return dir;
}

test("preparation updates dependent versions and root lock, preserves notes, and installs offline", () => {
  const dir = preparationFixture();
  try {
    const cwd = path.join(dir, "packages/demo");
    const before = snapshot(dir);
    const preview = run(cwd, ["--prepare", "--dry-run", "--bump", "patch"]);
    assert.equal(preview.status, 0, preview.stderr);
    const plan = JSON.parse(preview.stdout);
    assert.deepEqual(
      plan.packages.map((item) => [item.name, item.version]),
      [
        ["@uirouter/demo", "1.2.4"],
        ["@uirouter/client", "1.0.1"],
      ]
    );
    assert.deepEqual(snapshot(dir), before);
    const prepared = run(cwd, ["--prepare", "--bump", "patch"]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json")));
    assert.equal(lock.packages["packages/demo"].version, "1.2.4");
    assert.equal(lock.packages["packages/client"].version, "1.0.1");
    assert.equal(
      lock.packages["packages/client"].dependencies["@uirouter/demo"],
      "1.2.4"
    );
    assert.equal(
      lock.packages["packages/app"].dependencies["@uirouter/client"],
      "=1.0.1"
    );
    assert.deepEqual(lock.packages["node_modules/@uirouter/demo"], {
      resolved: "packages/demo",
      link: true,
    });
    const notes = readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
    assert.match(notes, /historical package fix/);
    assert.match(notes, /scoped package feature/);
    assert.match(notes, /Previous demo release notes/);
    assert.doesNotMatch(notes, /unrelated package change/);
    const dependentNotes = readFileSync(
      path.join(dir, "packages/client/CHANGELOG.md"),
      "utf8"
    );
    assert.match(dependentNotes, /@uirouter\/demo: 1.2.3 → 1.2.4/);
    assert.equal(git(dir, "show-ref"), before[1]);
    const install = spawnSync(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"],
      { cwd: dir, encoding: "utf8", timeout: 30000 }
    );
    assert.equal(install.status, 0, install.stderr);
    assert.equal(
      JSON.parse(
        readFileSync(path.join(dir, "node_modules/@uirouter/demo/package.json"))
      ).version,
      "1.2.4"
    );
    assert.ok(!readdirSync(cwd).includes("lifecycle-ran"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preparation rejects dirty trees, existing tags, and incompatible ranges without writes", () => {
  const dir = preparationFixture();
  try {
    const cwd = path.join(dir, "packages/demo");
    let before = snapshot(dir);
    let result = run(cwd, ["--prepare"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Release tag already exists/);
    assert.deepEqual(snapshot(dir), before);
    result = run(cwd, ["--prepare", "--bump", "major"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /review compatibility explicitly/);
    assert.deepEqual(snapshot(dir), before);
    write(dir, "uncommitted.txt", "keep this");
    before = snapshot(dir);
    result = run(cwd, ["--prepare", "--bump", "patch"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /clean checkout/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preparation restores every file if a write fails", () => {
  const dir = preparationFixture();
  const preloadDir = fixture();
  try {
    write(
      preloadDir,
      "fail-write.cjs",
      `const fs = require('fs'); const original = fs.writeFileSync; let failed = false; fs.writeFileSync = function(file, ...args) { if (!failed && String(file).endsWith('/packages/client/CHANGELOG.md')) { failed = true; throw new Error('injected write failure'); } return original.call(this, file, ...args); };`
    );
    const before = snapshot(dir);
    const result = spawnSync(
      process.execPath,
      [
        "--require",
        path.join(preloadDir, "fail-write.cjs"),
        release,
        "--prepare",
        "--bump",
        "patch",
      ],
      { cwd: path.join(dir, "packages/demo"), encoding: "utf8", timeout: 15000 }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /injected write failure/);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(preloadDir, { recursive: true, force: true });
  }
});

function addReleaseWorkspace(dir, id, manifest) {
  write(dir, `packages/${id}/package.json`, manifest);
  const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json")));
  lock.packages[`packages/${id}`] = manifest;
  lock.packages[`node_modules/${manifest.name}`] = {
    resolved: `packages/${id}`,
    link: true,
  };
  write(dir, "package-lock.json", lock);
  const inventory = JSON.parse(
    readFileSync(path.join(dir, "migration/package-artifacts.json"))
  );
  inventory.packages.push({
    id,
    package: manifest.name,
    manifest: `packages/${id}/package.json`,
    pack: { directory: "." },
  });
  write(dir, "migration/package-artifacts.json", inventory);
  const sources = JSON.parse(
    readFileSync(path.join(dir, "migration/sources.json"))
  );
  sources.sources.push({
    name: id,
    destinationPrefix: `packages/${id}`,
    tagNamespace: `${id}@`,
    releaseTags: [],
  });
  write(dir, "migration/sources.json", sources);
}

test("Angular preparation coordinates both packages and refuses a mismatched Angular major", () => {
  const dir = preparationFixture();
  try {
    for (const id of ["angular", "angular-hybrid"])
      addReleaseWorkspace(dir, id, {
        name: `@uirouter/${id}`,
        version: "22.0.0",
        peerDependencies: { "@angular/core": "^22.0.0" },
      });
    git(dir, "add", ".");
    git(dir, "commit", "-m", "feat: Angular fixture");
    const cwd = path.join(dir, "packages/angular");
    const before = snapshot(dir);
    const invalid = run(cwd, ["--prepare", "--bump", "major"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Angular package major/);
    assert.deepEqual(snapshot(dir), before);
    const result = run(cwd, ["--prepare", "--bump", "patch"]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.deepEqual(
      plan.packages.map((item) => item.version),
      ["22.0.1", "22.0.1"]
    );
    for (const id of ["angular", "angular-hybrid"])
      assert.equal(
        JSON.parse(readFileSync(path.join(dir, `packages/${id}/package.json`)))
          .version,
        "22.0.1"
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AngularJS notes retain authored text, announce Bower retirement once, and list both npm names", () => {
  const dir = preparationFixture();
  try {
    addReleaseWorkspace(dir, "angularjs", {
      name: "@uirouter/angularjs",
      version: "1.1.2",
      peerDependencies: { "@uirouter/demo": "^1.2.3" },
    });
    write(
      dir,
      "packages/angularjs/CHANGELOG.md",
      "# 1.1.3 (draft)\n\n# BREAKING CHANGES\n\nKeep this authored warning.\n\n# 1.1.2\n\nOlder notes.\n"
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "feat: AngularJS fixture");
    const cwd = path.join(dir, "packages/angularjs");
    const result = run(cwd, [
      "--prepare",
      "--bump",
      "patch",
      "--deps",
      "@uirouter/demo",
      "--legacy-angularjs",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).packages[0].npmPackages, [
      "@uirouter/angularjs",
      "angular-ui-router",
    ]);
    let notes = readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
    assert.equal((notes.match(/^# 1\.1\.3/gm) || []).length, 1);
    assert.match(notes, /Keep this authored warning/);
    assert.match(notes, /Older notes/);
    assert.match(notes, /@uirouter\/demo: not declared → \^1.2.3/);
    assert.equal(
      (notes.match(/New Bower releases have ended\./g) || []).length,
      1
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "prepare first draft");
    const next = run(cwd, ["--prepare", "--bump", "patch"]);
    assert.equal(next.status, 0, next.stderr);
    notes = readFileSync(path.join(cwd, "CHANGELOG.md"), "utf8");
    assert.equal(
      (notes.match(/New Bower releases have ended\./g) || []).length,
      1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependent releases retain a version already assigned to an unpublished release", () => {
  const dir = preparationFixture();
  try {
    const client = JSON.parse(
      readFileSync(path.join(dir, "packages/client/package.json"))
    );
    client.version = "1.1.0";
    client.repository = {
      url: "git+https://github.com/ui-router/ui-router.git",
    };
    write(dir, "packages/client/package.json", client);
    const app = JSON.parse(
      readFileSync(path.join(dir, "packages/app/package.json"))
    );
    app.dependencies["@uirouter/client"] = "=1.1.0";
    write(dir, "packages/app/package.json", app);
    const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json")));
    lock.packages["packages/client"] = client;
    lock.packages["packages/app"].dependencies = app.dependencies;
    write(dir, "package-lock.json", lock);
    write(
      dir,
      "packages/client/CHANGELOG.md",
      "# 1.1.0 (draft)\n[Compare old versions](https://github.com/ui-router/old-repo/compare/1.0.0...1.1.0)\n\nKeep the planned release notes.\n"
    );
    git(dir, "add", ".");
    git(dir, "commit", "-m", "plan next client release");
    const result = run(path.join(dir, "packages/demo"), [
      "--prepare",
      "--bump",
      "patch",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).packages.find(
        (item) => item.name === "@uirouter/client"
      ).version,
      "1.1.0"
    );
    const notes = readFileSync(
      path.join(dir, "packages/client/CHANGELOG.md"),
      "utf8"
    );
    assert.equal((notes.match(/^# 1\.1\.0/gm) || []).length, 1);
    assert.match(notes, /Keep the planned release notes/);
    assert.match(
      notes,
      /ui-router\/ui-router\/compare\/client%401.0.0\.\.\.client%401.1.0/
    );
    assert.doesNotMatch(notes, /old-repo/);
    assert.match(notes, /@uirouter\/demo: 1.2.3 → 1.2.4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact rehearsal restricts registry destinations and orders internal dependencies", async () => {
  const { localRegistry, orderedArtifacts } = await import(
    "./publish-scripts/publish_artifacts.js"
  ).then((m) => m.default);
  for (const url of [
    "https://registry.npmjs.org/",
    "http://localhost:4873/",
    "http://127.0.0.1:4873/path",
    "http://user@127.0.0.1:4873/",
    "http://127.0.0.1:4873/?x=1",
  ])
    assert.throws(() => localRegistry(url), /Rehearsal requires/);
  assert.equal(
    localRegistry("http://127.0.0.1:4873/"),
    "http://127.0.0.1:4873/"
  );
  const items = [
    {
      package: "app",
      manifest: {
        dependencies: { adapter: "1" },
        peerDependencies: { core: "1" },
      },
    },
    { package: "adapter", manifest: { dependencies: { core: "1" } } },
    { package: "core", manifest: {} },
  ];
  assert.deepEqual(
    orderedArtifacts(items, "app").map((x) => x.package),
    ["core", "adapter", "app"]
  );
  assert.throws(() => orderedArtifacts(items, "missing"), /absent/);
  items[2].manifest.dependencies = { app: "1" };
  assert.throws(() => orderedArtifacts(items, "app"), /cycle/);
});

test("artifact readback verifies retry bytes and rejects redirects and nonlocal downloads", async () => {
  const { createServer } = await import("node:http");
  const { readback } = await import(
    "./publish-scripts/publish_artifacts.js"
  ).then((m) => m.default);
  const bytes = Buffer.from("packed fixture");
  let mode = "ok",
    origin;
  const server = createServer((req, res) => {
    if (mode === "missing") {
      res.writeHead(404).end();
      return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: "https://registry.npmjs.org/" }).end();
      return;
    }
    if (req.url === "/archive") {
      res.end(mode === "bytes" ? "different" : bytes);
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        versions: {
          "1.0.0": {
            name: mode === "identity" ? "other" : "test",
            version: "1.0.0",
            dist: {
              integrity:
                mode === "integrity"
                  ? "wrong"
                  : "sha512-" +
                    createHash("sha512").update(bytes).digest("base64"),
              tarball:
                mode === "remote"
                  ? "https://registry.npmjs.org/test.tgz"
                  : origin + "archive",
            },
          },
        },
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}/`;
  const item = {
    package: "test",
    version: "1.0.0",
    manifest: { name: "test", version: "1.0.0" },
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    assert.equal(await readback(origin, item), true);
    mode = "missing";
    assert.equal(await readback(origin, item), false);
    for (const [value, expected] of [
      ["bytes", /bytes differ/],
      ["integrity", /integrity differs/],
      ["identity", /metadata differs/],
      ["remote", /loopback registry/],
      ["redirect", /fetch failed/],
    ]) {
      mode = value;
      await assert.rejects(readback(origin, item), expected);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
