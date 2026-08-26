#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  repository,
  scriptsSha256,
  sha256File,
  validatePackageArtifactsContract,
  validatePackageArtifactsEvidence,
  validateSourceMapReferences,
} from "./package-artifacts-lib.mjs";

let fixture;
let cases = 0;

async function readJson(filename) {
  return JSON.parse(await readFile(path.join(fixture, filename), "utf8"));
}

async function writeJson(filename, value) {
  await writeFile(
    path.join(fixture, filename),
    `${JSON.stringify(value, null, 2)}\n`
  );
}

async function expectFailure(
  name,
  filenames,
  mutate,
  expected,
  evidence = false
) {
  const originals = new Map();
  for (const filename of filenames)
    originals.set(filename, await readFile(path.join(fixture, filename)));
  try {
    await mutate();
    let failure;
    try {
      const { contract } = await validatePackageArtifactsContract({
        root: fixture,
      });
      if (evidence)
        await validatePackageArtifactsEvidence({ root: fixture, contract });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!failure) throw new Error(`${name}: mutation unexpectedly passed`);
    if (!failure.includes(expected))
      throw new Error(
        `${name}: expected ${JSON.stringify(
          expected
        )}, received ${JSON.stringify(failure)}`
      );
    cases += 1;
  } finally {
    for (const [filename, contents] of originals)
      await writeFile(path.join(fixture, filename), contents);
  }
}

function expectSourceMapFailure(name, sourceMap, expected) {
  let failure;
  try {
    validateSourceMapReferences(
      "source-map-fixture",
      "lib/index.js.map",
      sourceMap
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (!failure || !failure.includes(expected)) {
    throw new Error(
      `${name}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(
        failure
      )}`
    );
  }
  cases += 1;
}

async function pathExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch {
    return false;
  }
}

async function mutateContract(mutator) {
  const contract = await readJson("migration/package-artifacts.json");
  await mutator(contract);
  await writeJson("migration/package-artifacts.json", contract);
}

async function mutateManifest(
  manifestPath,
  mutator,
  { updateScripts = false } = {}
) {
  const manifest = await readJson(manifestPath);
  await mutator(manifest);
  await writeJson(manifestPath, manifest);
  const contract = await readJson("migration/package-artifacts.json");
  const record = contract.packages.find(
    (candidate) => candidate.manifest === manifestPath
  );
  record.manifestSha256 = await sha256File(path.join(fixture, manifestPath));
  if (updateScripts) record.scriptsSha256 = scriptsSha256(manifest);
  await writeJson("migration/package-artifacts.json", contract);
}

try {
  fixture = await mkdtemp(path.join(os.tmpdir(), "uirouter-p01-adversarial-"));
  await cp(repository, fixture, {
    recursive: true,
    filter(source) {
      if (source === repository) return true;
      const relative = path.relative(repository, source);
      const segments = relative.split(path.sep);
      return !segments.some((segment) =>
        [".git", ".artifacts", ".turbo", "node_modules"].includes(segment)
      );
    },
  });

  await validatePackageArtifactsContract({ root: fixture });
  const { contract } = await validatePackageArtifactsContract({
    root: fixture,
  });
  await validatePackageArtifactsEvidence({ root: fixture, contract });
  validateSourceMapReferences("source-map-fixture", "lib/index.js.map", {
    version: 3,
    sourceRoot: "../",
    sources: ["src/index.ts"],
  });
  expectSourceMapFailure(
    "source-map-webpack-uri",
    { sources: ["webpack://package/src/index.ts"] },
    "has URI source"
  );
  expectSourceMapFailure(
    "source-map-uppercase-file-uri",
    { sources: ["FILE:///tmp/source.ts"] },
    "has URI source"
  );
  expectSourceMapFailure(
    "source-map-http-root",
    { sourceRoot: "https://example.test/", sources: ["index.ts"] },
    "has URI sourceRoot"
  );
  expectSourceMapFailure(
    "source-map-checkout-relative",
    { sources: ["frameworks/react/uirouter-react/src/index.ts"] },
    "has checkout-relative source"
  );
  expectSourceMapFailure(
    "source-map-non-string",
    { sources: [42] },
    "non-string or empty source"
  );
  expectSourceMapFailure(
    "source-map-backslash",
    { sources: ["..\\src\\index.ts"] },
    "non-normalized source"
  );
  expectSourceMapFailure(
    "source-map-dot-segment",
    { sources: [".././src/index.ts"] },
    "non-normalized source"
  );
  expectSourceMapFailure(
    "source-map-non-array",
    { sources: "src/index.ts" },
    "non-array sources"
  );

  await expectFailure(
    "classification-digest",
    ["migration/package-classification.json"],
    async () => {
      const value = await readJson("migration/package-classification.json");
      value.schemaVersion += 1;
      await writeJson("migration/package-classification.json", value);
    },
    "packageClassificationSha256 differs"
  );
  await expectFailure(
    "path-repairs-digest",
    ["migration/path-repairs.json"],
    async () => {
      const value = await readJson("migration/path-repairs.json");
      value.schemaVersion += 1;
      await writeJson("migration/path-repairs.json", value);
    },
    "pathRepairsSha256 differs"
  );
  await expectFailure(
    "source-aliases-digest",
    ["migration/source-aliases.json"],
    async () => {
      const value = await readJson("migration/source-aliases.json");
      value.schemaVersion += 1;
      await writeJson("migration/source-aliases.json", value);
    },
    "sourceAliasesSha256 differs"
  );
  await expectFailure(
    "turbo-digest",
    ["turbo.json"],
    async () => {
      const value = await readJson("turbo.json");
      value.ui = "stream";
      await writeJson("turbo.json", value);
    },
    "turboJsonSha256 differs"
  );
  await expectFailure(
    "root-lock-digest",
    ["package-lock.json"],
    async () => {
      const value = await readJson("package-lock.json");
      value.name = "mutated";
      await writeJson("package-lock.json", value);
    },
    "rootLockSha256 differs"
  );
  await expectFailure(
    "runtime",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.runtime.npm = "0.0.0";
      }),
    "runtime differs"
  );
  await expectFailure(
    "environment",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.normalizedEnvironment.CI = "false";
      }),
    "normalized environment differs"
  );
  await expectFailure(
    "turbo-pack-cache",
    ["turbo.json", "migration/package-artifacts.json"],
    async () => {
      const turbo = await readJson("turbo.json");
      turbo.tasks.pack.cache = true;
      await writeJson("turbo.json", turbo);
      await mutateContract(async (value) => {
        value.turboJsonSha256 = await sha256File(
          path.join(fixture, "turbo.json")
        );
      });
    },
    "Turbo pack task must remain uncached"
  );
  await expectFailure(
    "missing-package",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.packages.pop();
      }),
    "array has fewer than 12 items"
  );
  await expectFailure(
    "duplicate-package-id",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.packages[1].id = value.packages[0].id;
      }),
    "package id repeats"
  );
  await expectFailure(
    "missing-edge",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.packages
          .find((record) => record.internalEdgeIds.length)
          .internalEdgeIds.pop();
      }),
    "internal production edges differs"
  );
  await expectFailure(
    "entrypoint-target",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.packages[0].entrypoints[0].target = "missing.js";
      }),
    "target is not required"
  );
  await expectFailure(
    "build-output",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.packages.find((record) => record.build).build.outputs = [
          "wrong/**",
        ];
      }),
    "build outputs differs"
  );
  await expectFailure(
    "angular-pack-directory",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.packages.find(
          (record) => record.id === "angular"
        ).pack.directory = ".";
      }),
    "Angular pack directory must be dist"
  );
  await expectFailure(
    "lock-scripts-enabled",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.consumer.lockArgv = value.consumer.lockArgv.filter(
          (arg) => arg !== "--ignore-scripts"
        );
      }),
    "consumer lock command"
  );
  await expectFailure(
    "missing-external-peer",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        delete value.consumer.dependencies.angular;
      }),
    "external peer angular is absent"
  );
  await expectFailure(
    "react-line",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.consumer.dependencies.react = "18.3.1";
      }),
    "exact React 19"
  );
  await expectFailure(
    "nondeterminism-waiver",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.artifactPolicy.waivers.push("mutated");
      }),
    "Contract schema validation failed"
  );
  await expectFailure(
    "manifest-digest",
    ["core/package.json"],
    async () => {
      const value = await readJson("core/package.json");
      value.description = "mutated";
      await writeJson("core/package.json", value);
    },
    "core manifest digest differs"
  );
  await expectFailure(
    "scripts-digest",
    ["migration/package-artifacts.json"],
    () =>
      mutateContract((value) => {
        value.packages[0].scriptsSha256 = "0".repeat(64);
      }),
    "scripts digest differs"
  );
  await expectFailure(
    "canonical-pack-helper",
    ["tools/publish-scripts/package.json", "migration/package-artifacts.json"],
    () =>
      mutateManifest(
        "tools/publish-scripts/package.json",
        (value) => {
          value.scripts.pack = "npm pack";
        },
        { updateScripts: true }
      ),
    "pack script is not the canonical helper path"
  );
  await expectFailure(
    "files-policy",
    ["plugins/rx/package.json", "migration/package-artifacts.json"],
    () =>
      mutateManifest("plugins/rx/package.json", (value) => {
        value.files.push("src");
      }),
    "manifest files policy differs"
  );
  await expectFailure(
    "undeclared-external-peer",
    ["plugins/redux/package.json", "migration/package-artifacts.json"],
    () =>
      mutateManifest("plugins/redux/package.json", (value) => {
        value.peerDependencies["p01-missing-peer"] = "^1.0.0";
      }),
    "external peer p01-missing-peer is absent"
  );
  await expectFailure(
    "package-private",
    ["plugins/rx/package.json", "migration/package-artifacts.json"],
    () =>
      mutateManifest("plugins/rx/package.json", (value) => {
        value.private = true;
      }),
    "is unexpectedly private"
  );
  await expectFailure(
    "evidence-contract-digest",
    ["migration/evidence/p01/package-proof.json"],
    async () => {
      const value = await readJson("migration/evidence/p01/package-proof.json");
      value.contractSha256 = "0".repeat(64);
      await writeJson("migration/evidence/p01/package-proof.json", value);
    },
    "package proof contract digest differs",
    true
  );
  await expectFailure(
    "evidence-artifact-filename",
    ["migration/evidence/p01/package-proof.json"],
    async () => {
      const value = await readJson("migration/evidence/p01/package-proof.json");
      value.packages[0].filename = "not-content-addressed.tgz";
      await writeJson("migration/evidence/p01/package-proof.json", value);
    },
    "filename is not the exact content-addressed basename",
    true
  );
  await expectFailure(
    "evidence-artifact-traversal",
    ["migration/evidence/p01/package-proof.json"],
    async () => {
      const value = await readJson("migration/evidence/p01/package-proof.json");
      value.packages[0].filename = `../${value.packages[0].filename}`;
      await writeJson("migration/evidence/p01/package-proof.json", value);
    },
    "filename is not the exact content-addressed basename",
    true
  );
  await expectFailure(
    "evidence-probe-count",
    ["migration/evidence/p01/package-proof.json"],
    async () => {
      const value = await readJson("migration/evidence/p01/package-proof.json");
      value.consumer.entrypoints += 1;
      await writeJson("migration/evidence/p01/package-proof.json", value);
    },
    "consumer probe counts differ",
    true
  );
  await expectFailure(
    "evidence-waiver",
    ["migration/evidence/p01/package-proof.json"],
    async () => {
      const value = await readJson("migration/evidence/p01/package-proof.json");
      value.waivers.push({ id: "mutated" });
      await writeJson("migration/evidence/p01/package-proof.json", value);
    },
    "package proof must not contain waivers",
    true
  );
  await expectFailure(
    "consumer-registry-fallback",
    ["migration/evidence/p01/consumer-package-lock.json"],
    async () => {
      const value = await readJson(
        "migration/evidence/p01/consumer-package-lock.json"
      );
      value.packages["node_modules/@uirouter/core"].resolved =
        "https://registry.npmjs.org/@uirouter/core/-/core-6.1.2.tgz";
      await writeJson(
        "migration/evidence/p01/consumer-package-lock.json",
        value
      );
    },
    "consumer evidence does not bind its local content-addressed tarball",
    true
  );
  await expectFailure(
    "consumer-path-traversal",
    ["migration/evidence/p01/consumer-package-lock.json"],
    async () => {
      const value = await readJson(
        "migration/evidence/p01/consumer-package-lock.json"
      );
      const record = value.packages["node_modules/@uirouter/core"];
      record.resolved = `file:../artifacts/sub/../${path.posix.basename(
        record.resolved
      )}`;
      await writeJson(
        "migration/evidence/p01/consumer-package-lock.json",
        value
      );
    },
    "consumer evidence does not bind its local content-addressed tarball",
    true
  );

  const sentinelRoot = path.join(
    repository,
    "node_modules",
    ...contract.consumer.sentinelPackage.split("/")
  );
  if (await pathExists(sentinelRoot))
    throw new Error("sentinel-collision: test precondition already exists");
  await mkdir(sentinelRoot, { recursive: true });
  const sentinelMarker = path.join(sentinelRoot, "preserve.txt");
  await writeFile(sentinelMarker, "preserve\n");
  try {
    const result = spawnSync(
      process.execPath,
      ["tools/prove-package-artifacts.mjs"],
      {
        cwd: repository,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (
      result.status === 0 ||
      !output.includes("root-only sentinel path already exists")
    ) {
      throw new Error(
        `sentinel-collision: expected collision failure, received ${output}`
      );
    }
    if ((await readFile(sentinelMarker, "utf8")) !== "preserve\n") {
      throw new Error("sentinel-collision: pre-existing sentinel was changed");
    }
    cases += 1;
  } finally {
    await rm(sentinelRoot, { recursive: true, force: true });
  }

  console.log(`PACKAGE_ARTIFACTS_ADVERSARIAL_TESTS_OK cases=${cases}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (fixture) await rm(fixture, { recursive: true, force: true });
}
