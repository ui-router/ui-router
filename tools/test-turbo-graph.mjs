#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ".gitignore",
  "migration/evidence/s03/turbo-graph.json",
  "package.json",
  "package-lock.json",
  "turbo.json",
];
const originals = new Map(
  files.map((file) => [file, readFileSync(path.join(root, file))])
);
const restore = () => {
  for (const [file, bytes] of originals)
    writeFileSync(path.join(root, file), bytes);
};
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restore();
  process.exit(143);
});

function json(file) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

function writeJson(file, value) {
  writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
}

const cases = [
  {
    name: "turbo-evidence-lock",
    mutate() {
      const value = json("migration/evidence/s03/turbo-graph.json");
      value.rootLock.afterPackageEntries = 4295;
      writeJson("migration/evidence/s03/turbo-graph.json", value);
    },
    message: "S03 Turbo evidence digest",
  },
  {
    name: "turbo-state-ignore",
    mutate() {
      const gitignore = readFileSync(
        path.join(root, ".gitignore"),
        "utf8"
      ).replace(".turbo/\n", "");
      writeFileSync(path.join(root, ".gitignore"), gitignore);
    },
    message: "root .gitignore must exclude",
  },
  {
    name: "topological-build-edge",
    mutate() {
      const value = json("turbo.json");
      value.tasks.build.dependsOn = ["clean"];
      writeJson("turbo.json", value);
    },
    message: "generic task build",
  },
  {
    name: "build-cache-boundary",
    mutate() {
      const value = json("turbo.json");
      value.tasks["@uirouter/core#build"].cache = true;
      writeJson("turbo.json", value);
    },
    message: "@uirouter/core build task",
  },
  {
    name: "package-output-ownership",
    mutate() {
      const value = json("turbo.json");
      value.tasks["@uirouter/redux#build"].outputs = ["lib/**"];
      writeJson("turbo.json", value);
    },
    message: "@uirouter/redux build task",
  },
  {
    name: "complete-build-coverage",
    mutate() {
      const value = json("turbo.json");
      delete value.tasks["@uirouter/angular#build"];
      writeJson("turbo.json", value);
    },
    message: "@uirouter/angular build task",
  },
  {
    name: "source-test-input",
    mutate() {
      const value = json("turbo.json");
      value.tasks["@uirouter/angular#test"].inputs = value.tasks[
        "@uirouter/angular#test"
      ].inputs.filter((input) => input !== "$TURBO_ROOT$/core/src/**");
      writeJson("turbo.json", value);
    },
    message: "@uirouter/angular source test task",
  },
  {
    name: "watch-persistence",
    mutate() {
      const value = json("turbo.json");
      value.tasks["@uirouter/react#test:watch"].persistent = false;
      writeJson("turbo.json", value);
    },
    message: "@uirouter/react source watch task",
  },
  {
    name: "watch-cache-boundary",
    mutate() {
      const value = json("turbo.json");
      value.tasks["@uirouter/rx#test:watch"].cache = true;
      writeJson("turbo.json", value);
    },
    message: "@uirouter/rx source watch task",
  },
  {
    name: "e2e-cache-boundary",
    mutate() {
      const value = json("turbo.json");
      value.tasks.e2e.cache = true;
      writeJson("turbo.json", value);
    },
    message: "generic task e2e",
  },
  {
    name: "test-environment-input",
    mutate() {
      const value = json("turbo.json");
      delete value.tasks["@uirouter/dsr#test"].env;
      writeJson("turbo.json", value);
    },
    message: "@uirouter/dsr source test task",
  },
  {
    name: "remote-cache-scope",
    mutate() {
      const value = json("turbo.json");
      value.remoteCache = { signature: true };
      writeJson("turbo.json", value);
    },
    message: "remote caching is outside S03",
  },
  {
    name: "exact-turbo-pin",
    mutate() {
      const value = json("package.json");
      value.devDependencies.turbo = "^2.10.12";
      writeJson("package.json", value);
    },
    message: "root turbo pin",
  },
  {
    name: "locked-turbo-integrity",
    mutate() {
      const value = json("package-lock.json");
      value.packages["node_modules/turbo"].integrity = "sha512-invalid";
      writeJson("package-lock.json", value);
    },
    message: "S03 Turbo lock evidence",
  },
  {
    name: "root-task-selection",
    mutate() {
      const value = json("package.json");
      value.scripts.test = "turbo run test";
      writeJson("package.json", value);
    },
    message: "root script test",
  },
];

try {
  for (const testCase of cases) {
    restore();
    testCase.mutate();
    const result = spawnSync(
      process.execPath,
      ["tools/verify-turbo-graph.mjs"],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
        maxBuffer: 128 * 1024 * 1024,
      }
    );
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status === 0)
      throw new Error(`${testCase.name}: verifier accepted mutation`);
    if (!output.includes(testCase.message)) {
      throw new Error(
        `${testCase.name}: expected ${JSON.stringify(
          testCase.message
        )}, got:\n${output}`
      );
    }
  }
} finally {
  restore();
}

console.log(`TURBO_GRAPH_ADVERSARIAL_TESTS_OK cases=${cases.length}`);
