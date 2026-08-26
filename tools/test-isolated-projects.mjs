#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  I01_CHANGED_FILES,
  validateI01ChangedFiles,
} from "./i01-scope-lib.mjs";

const repository = path.resolve(import.meta.dirname, "..");
const verifier = path.join(repository, "tools/verify-isolated-projects.mjs");
const classification = readJson(
  repository,
  "migration/package-classification.json"
);
const repairs = readJson(repository, "migration/path-repairs.json");
const inventory = readJson(
  repository,
  "migration/evidence/control/n00/inventory.json"
);
function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}
function writeJson(root, relative, value) {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}
function fileSha(root, relative) {
  return createHash("sha256")
    .update(readFileSync(path.join(root, relative)))
    .digest("hex");
}
function canonicalize(input) {
  let current = input;
  for (const move of repairs.moves)
    if (current === move.from || current.startsWith(`${move.from}/`))
      current = `${move.to}${current.slice(move.from.length)}`;
  return current;
}
function copyFile(root, relative) {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(path.join(repository, relative), destination);
}
function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "uirouter-i01-"));
  for (const relative of [
    "package.json",
    "package-lock.json",
    "migration/isolated-projects.json",
    "migration/package-classification.json",
    "migration/path-repairs.json",
    "migration/baselines.json",
    "migration/sources.json",
    "migration/execution-lock.json",
    "migration/evidence/control/n00/inventory.json",
    "migration/evidence/i01/install-proof.json",
    "migration/evidence/i01/isolation-proof.json",
    "migration/schemas/contract-common.schema.json",
    "migration/schemas/isolated-projects.schema.json",
    "tools/i01-scope-lib.mjs",
    "tools/prove-npm-installs.mjs",
    "tools/test-isolated-projects.mjs",
    "tools/verify-isolated-projects.mjs",
  ])
    copyFile(root, relative);
  for (const record of classification.manifests)
    copyFile(root, canonicalize(record.path));
  const contract = readJson(repository, "migration/isolated-projects.json");
  for (const project of contract.projects) {
    if (project.lock) copyFile(root, project.lock.path);
    if (project.generatorScript) copyFile(root, project.generatorScript);
  }
  for (const source of inventory.sources) {
    if (source.downstreamProjects === null) continue;
    const rootSnapshot = source.manifests.find(
      (snapshot) => snapshot.sourcePath === "package.json"
    );
    copyFile(
      root,
      `${path.posix.dirname(
        canonicalize(rootSnapshot.finalPath)
      )}/downstream_projects.json`
    );
  }
  return root;
}
function mutateJson(root, relative, callback) {
  const value = readJson(root, relative);
  callback(value);
  writeJson(root, relative, value);
}
function run(root, fixtureMode = root !== repository) {
  const args = [verifier, "--root", root];
  if (fixtureMode) args.push("--test-fixture-no-git");
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: fixtureMode ? { ...process.env, I01_TEST_FIXTURE: "1" } : process.env,
  });
}
function updateContractFileSha(root, field, relative) {
  mutateJson(root, "migration/isolated-projects.json", (contract) => {
    contract[field] = fileSha(root, relative);
  });
}
function updateProjectLockSha(root, id) {
  mutateJson(root, "migration/isolated-projects.json", (contract) => {
    const project = contract.projects.find((candidate) => candidate.id === id);
    project.lock.sha256 = fileSha(root, project.lock.path);
  });
}

const positive = run(repository);
if (positive.status !== 0)
  throw new Error(
    `positive I01 validation failed:\n${positive.stdout}\n${positive.stderr}`
  );

const gitlessRoot = makeFixture();
try {
  const gitless = run(gitlessRoot, false);
  const output = `${gitless.stdout}\n${gitless.stderr}`;
  if (
    gitless.status === 0 ||
    !output.includes(
      "Git repository required for I01 change-closure verification"
    )
  ) {
    throw new Error(
      `Git-less normal validation did not fail closed:\n${output}`
    );
  }
} finally {
  rmSync(gitlessRoot, { recursive: true, force: true });
}

const cases = [
  {
    name: "classification digest is bound",
    mutate: (root) =>
      mutateJson(root, "migration/isolated-projects.json", (contract) => {
        contract.packageClassificationSha256 = "0".repeat(64);
      }),
    expected: "packageClassificationSha256 digest mismatch",
  },
  {
    name: "project inventory is exhaustive",
    mutate: (root) =>
      mutateJson(root, "migration/isolated-projects.json", (contract) => {
        contract.projects.pop();
      }),
    expected: "schema:",
  },
  {
    name: "canonical paths compose through repairs",
    mutate: (root) =>
      mutateJson(root, "migration/isolated-projects.json", (contract) => {
        contract.projects[0].manifest = contract.projects[0].sourceManifest;
      }),
    expected: "manifest mismatch",
  },
  {
    name: "script semantics are hash-bound",
    mutate: (root) =>
      mutateJson(
        root,
        "core/integration-tests/typescript-3.9/package.json",
        (manifest) => {
          manifest.scripts.test = "tsc --noEmit";
        }
      ),
    expected: "manifestSha256 mismatch",
  },
  {
    name: "browser setup remains explicit",
    mutate: (root) =>
      mutateJson(
        root,
        "frameworks/angular/integration-tests/angular-versions/v22/package.json",
        (manifest) => {
          delete manifest.scripts["setup:browser"];
        }
      ),
    expected: "e2e and setup:browser must remain paired",
  },
  {
    name: "committed source specs are retained",
    mutate: (root) =>
      mutateJson(
        root,
        "core/integration-tests/typescript-3.9/package.json",
        (manifest) => {
          manifest.dependencies["@uirouter/core"] = "^6.1.2";
        }
      ),
    expected: "committed manifest no longer retains source spec",
  },
  {
    name: "local lock snapshots are exact",
    mutate: (root) =>
      mutateJson(
        root,
        "core/integration-tests/typescript-3.9/package-lock.json",
        (lock) => {
          lock.i01Mutation = true;
        }
      ),
    expected: "lock mismatch",
  },
  {
    name: "registry baselines cannot become local files",
    mutate: (root) => {
      mutateJson(
        root,
        "core/integration-tests/typescript-3.9/package-lock.json",
        (lock) => {
          lock.packages["node_modules/@uirouter/core"].resolved =
            "file:../../core.tgz";
        }
      );
      updateProjectLockSha(root, "core/integration/typescript-3.9");
    },
    expected: "does not preserve an integrity-bound npm registry baseline",
  },
  {
    name: "legacy-only dependencies stay absent from baseline locks",
    mutate: (root) => {
      mutateJson(
        root,
        "frameworks/react/integration-tests/react17/package-lock.json",
        (lock) => {
          lock.packages["node_modules/@uirouter/react"] = {
            version: "1.0.8",
            resolved:
              "https://registry.npmjs.org/@uirouter/react/-/react-1.0.8.tgz",
            integrity: "sha512-test",
          };
        }
      );
      updateProjectLockSha(root, "framework/react/integration/react17");
    },
    expected:
      "legacy-only dependency leaked into the committed registry baseline lock",
  },
  {
    name: "current downstream relation remains explicit",
    mutate: (root) =>
      mutateJson(root, "core/downstream_projects.json", (projects) => {
        delete projects.other["typescript3.9"];
      }),
    expected:
      "current downstream configuration no longer derives the classified relation",
  },
  {
    name: "source-era downstream evidence remains complete",
    mutate: (root) => {
      mutateJson(root, "migration/baselines.json", (baselines) => {
        for (const entry of baselines.entries)
          entry.legacyInjectedEdges = entry.legacyInjectedEdges.filter(
            (edge) => edge !== "yalc:@uirouter/core->./test/typescript3.9"
          );
      });
      updateContractFileSha(
        root,
        "baselinesSha256",
        "migration/baselines.json"
      );
    },
    expected: "expected one passing downstream-discovery baseline",
  },
  {
    name: "templates never own locks",
    mutate: (root) =>
      writeJson(
        root,
        "frameworks/angular/integration-tests/typescript-versions/scaffold/package-lock.json",
        { lockfileVersion: 3, packages: {} }
      ),
    expected: "generator template must not own a lock",
  },
  {
    name: "templates retain executable generators",
    mutate: (root) =>
      chmodSync(
        path.join(
          root,
          "frameworks/angularjs/integration-tests/typescript-versions/mktest.sh"
        ),
        0o644
      ),
    expected: "generator script is not executable",
  },
  {
    name: "isolated projects cannot enter workspaces",
    mutate: (root) =>
      mutateJson(root, "package.json", (manifest) => {
        manifest.workspaces.push("core/integration-tests/typescript-3.9");
      }),
    expected: "root workspace globs mismatch",
  },
  {
    name: "ordinary examples cannot gain local locks",
    mutate: (root) =>
      writeJson(
        root,
        "frameworks/react/examples/typescript/package-lock.json",
        { lockfileVersion: 3, packages: {} }
      ),
    expected: "ordinary example must not own a local lock",
  },
  {
    name: "registry baseline records are exact",
    mutate: (root) =>
      mutateJson(root, "migration/isolated-projects.json", (contract) => {
        contract.projects[0].registryBaselineRecords[0].version = "0.0.0";
      }),
    expected: "registryBaselineRecords mismatch",
  },
  {
    name: "isolated manifest discovery rejects extras",
    mutate: (root) =>
      writeJson(root, "core/integration-tests/unclassified/package.json", {
        name: "unclassified",
        private: true,
      }),
    expected: "isolated manifest inventory mismatch",
  },
  {
    name: "classification cannot silently change template ownership",
    mutate: (root) => {
      mutateJson(root, "migration/package-classification.json", (value) => {
        const record = value.manifests.find(
          (candidate) =>
            candidate.id ===
            "framework/angular/integration/typescript-versions/scaffold"
        );
        record.lockOwner = "local";
        record.internalResolutionMode = "local-tarball";
      });
      updateContractFileSha(
        root,
        "packageClassificationSha256",
        "migration/package-classification.json"
      );
    },
    expected: "runnable project must own exactly one legacy-injected edge",
  },
  {
    name: "evidence base is immutable",
    mutate: (root) =>
      mutateJson(
        root,
        "migration/evidence/i01/isolation-proof.json",
        (evidence) => {
          evidence.baseCommit = "0".repeat(40);
        }
      ),
    expected: "I01 evidence base mismatch",
  },
  {
    name: "evidence implementation hashes are exact",
    mutate: (root) =>
      mutateJson(
        root,
        "migration/evidence/i01/isolation-proof.json",
        (evidence) => {
          evidence.implementation.verifierSha256 = "0".repeat(64);
        }
      ),
    expected: "I01 evidence implementation mismatch",
  },
  {
    name: "install evidence requires every local success",
    mutate: (root) => {
      mutateJson(root, "migration/evidence/i01/install-proof.json", (proof) => {
        proof.localRuns[0].ciExitStatus = 1;
      });
      mutateJson(
        root,
        "migration/evidence/i01/isolation-proof.json",
        (evidence) => {
          evidence.installProof.sha256 = fileSha(
            root,
            "migration/evidence/i01/install-proof.json"
          );
        }
      );
    },
    expected: "approved install proof digest mismatch",
  },
  {
    name: "source-change boundary is evidence-bound",
    mutate: (root) =>
      mutateJson(
        root,
        "migration/evidence/i01/isolation-proof.json",
        (evidence) => {
          evidence.sourceChanges.localLockFilesChanged = 1;
        }
      ),
    expected: "I01 source-change boundary mismatch",
  },
];

for (const testCase of cases) {
  const root = makeFixture();
  try {
    testCase.mutate(root);
    const result = run(root);
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes(testCase.expected)) {
      throw new Error(
        `${testCase.name} did not fail as expected (status ${result.status}):\n${output}`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const forbiddenScopePaths = [
  "core/integration-tests/typescript-3.9/package.json",
  "frameworks/react/integration-tests/react17/package-lock.json",
  "tools/run-integration-matrix.mjs",
  "core/rollup.config.js",
  ".github/workflows/ci.yml",
];
for (const forbiddenPath of forbiddenScopePaths) {
  const records = [...I01_CHANGED_FILES].map(([file, status]) => ({
    path: file,
    status,
  }));
  records.push({ path: forbiddenPath, status: "M" });
  try {
    validateI01ChangedFiles(records);
    throw new Error(`scope closure accepted forbidden ${forbiddenPath}`);
  } catch (error) {
    if (!error.message.includes(`forbidden M ${forbiddenPath}`)) throw error;
  }
}
const totalCases = cases.length + forbiddenScopePaths.length + 1;
console.log(`I01_ISOLATED_PROJECT_ADVERSARIAL_TESTS_OK cases=${totalCases}`);
