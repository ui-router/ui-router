#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  throw new Error(`TURBO_GRAPH_VERIFY_FAILED: ${message}`);
};
const readJson = (relativePath) =>
  JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const equal = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(
        actual
      )}`
    );
  }
};
const sorted = (values) =>
  [...values].sort((left, right) => left.localeCompare(right));
const normalize = (value) => value.split(path.sep).join("/");
const sha256 = (relativePath) =>
  createHash("sha256")
    .update(readFileSync(path.join(root, relativePath)))
    .digest("hex");

const rootManifest = readJson("package.json");
const rootLock = readJson("package-lock.json");
const turbo = readJson("turbo.json");
const aliases = readJson("migration/source-aliases.json");
const turboEvidencePath = "migration/evidence/s03/turbo-graph.json";
equal(
  "S03 Turbo evidence digest",
  sha256(turboEvidencePath),
  "3362046ab45dc9400ca16a026b0d478d9ce57e26bc1901bbabf6018b4b6f1bbd"
);
const turboEvidence = readJson(turboEvidencePath);
equal(
  "S03 Turbo evidence identity",
  {
    schemaVersion: turboEvidence.schemaVersion,
    task: turboEvidence.task,
    owner: turboEvidence.owner,
    baseCommit: turboEvidence.baseCommit,
  },
  {
    schemaVersion: 1,
    task: "S03",
    owner: "ui-router-maintainers",
    baseCommit: "25e382a7994268f37411f4dfaa5a97ce3e2fa2d3",
  }
);
equal("S03 Turbo lock evidence", turboEvidence.rootLock, {
  beforeSha256:
    "2dc333cc65a5b88ea0932e20c6ef67f337288a63b12bc6cf585cf539480dfee4",
  afterSha256: sha256("package-lock.json"),
  beforePackageEntries: 4289,
  afterPackageEntries: 4296,
  addedPackageKeys: [
    "node_modules/@turbo/darwin-64",
    "node_modules/@turbo/darwin-arm64",
    "node_modules/@turbo/linux-64",
    "node_modules/@turbo/linux-arm64",
    "node_modules/@turbo/windows-64",
    "node_modules/@turbo/windows-arm64",
    "node_modules/turbo",
  ],
});
equal("S03 Turbo runtime evidence", turboEvidence.runtime, {
  node: "v24.19.0",
  npm: "11.17.0",
  imageDigest:
    "sha256:56ab6ddaab798f0664b18448a1226bfa9e43aefaa90af280ff79d05c350a2ef8",
});
equal("S03 Turbo package evidence", turboEvidence.turbo, {
  version: "2.10.12",
  integrity:
    "sha512-AswgMPnpOoaVZHrrSBejETzEbuIA69OVGwfkHwfrY0A23VjWXBANzgq9+OymWOHAIArB7D1+1z498WY8fGg1Jw==",
  remoteCache: false,
});
const rootGitignore = readFileSync(path.join(root, ".gitignore"), "utf8").split(
  /\r?\n/u
);
if (!rootGitignore.includes(".turbo/"))
  fail("root .gitignore must exclude per-package and root Turbo state");

function segmentPattern(segment) {
  const escaped = segment
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function expandWorkspacePattern(pattern) {
  let current = [""];
  for (const segment of pattern.split("/")) {
    const matcher = segmentPattern(segment);
    const next = [];
    for (const relativeBase of current) {
      const absoluteBase = path.join(root, relativeBase);
      if (!existsSync(absoluteBase)) continue;
      for (const entry of readdirSync(absoluteBase, { withFileTypes: true })) {
        if (entry.isDirectory() && matcher.test(entry.name))
          next.push(path.join(relativeBase, entry.name));
      }
    }
    current = next;
  }
  return current
    .map(normalize)
    .filter((directory) =>
      existsSync(path.join(root, directory, "package.json"))
    );
}

const workspaceDirectories = sorted(
  new Set(rootManifest.workspaces.flatMap(expandWorkspacePattern))
);
if (workspaceDirectories.length !== 26)
  fail(`expected 26 root workspaces, found ${workspaceDirectories.length}`);

const workspaces = workspaceDirectories.map((directory) => {
  const manifest = readJson(`${directory}/package.json`);
  if (!manifest.name) fail(`${directory}/package.json has no package name`);
  return { directory, manifest };
});
const workspaceByName = new Map(
  workspaces.map((workspace) => [workspace.manifest.name, workspace])
);
if (workspaceByName.size !== workspaces.length)
  fail("workspace package names are not unique");

const packageFilters =
  "--filter='./core' --filter='./frameworks/*/uirouter-*' --filter='./plugins/*'";
const exampleFilters =
  "--filter='./frameworks/*/examples/*' --filter='./plugins/*/examples/*'";
const expectedRootScripts = {
  build: `turbo run build ${packageFilters}`,
  "build:workspaces": "turbo run build",
  lint: `turbo run lint ${packageFilters}`,
  typecheck: `turbo run typecheck ${packageFilters}`,
  test: `turbo run test ${packageFilters}`,
  "test:watch": `turbo run test:watch ${packageFilters} --concurrency=16`,
  docs: `turbo run docs ${packageFilters}`,
  "setup:browser": `turbo run setup:browser ${exampleFilters}`,
  e2e: `turbo run e2e ${exampleFilters}`,
};
for (const [name, command] of Object.entries(expectedRootScripts)) {
  equal(`root script ${name}`, rootManifest.scripts?.[name], command);
}
if (!rootManifest.scripts?.check?.includes("npm run verify:turbo"))
  fail("root check does not run verify:turbo");
equal(
  "root verify:turbo script",
  rootManifest.scripts?.["verify:turbo"],
  "node tools/verify-turbo-graph.mjs"
);
equal(
  "root test:turbo script",
  rootManifest.scripts?.["test:turbo"],
  "node tools/test-turbo-graph.mjs"
);
equal(
  "root prove:turbo script",
  rootManifest.scripts?.["prove:turbo"],
  "node tools/prove-turbo-graph.mjs"
);

const turboVersion = "2.10.12";
const turboIntegrity =
  "sha512-AswgMPnpOoaVZHrrSBejETzEbuIA69OVGwfkHwfrY0A23VjWXBANzgq9+OymWOHAIArB7D1+1z498WY8fGg1Jw==";
equal("root turbo pin", rootManifest.devDependencies?.turbo, turboVersion);
equal(
  "lock root turbo pin",
  rootLock.packages?.[""]?.devDependencies?.turbo,
  turboVersion
);
const turboLock = rootLock.packages?.["node_modules/turbo"];
if (!turboLock) fail("root lock has no node_modules/turbo record");
equal("locked turbo version", turboLock.version, turboVersion);
equal("locked turbo integrity", turboLock.integrity, turboIntegrity);
equal("locked turbo optional dependencies", turboLock.optionalDependencies, {
  "@turbo/darwin-64": turboVersion,
  "@turbo/darwin-arm64": turboVersion,
  "@turbo/linux-64": turboVersion,
  "@turbo/linux-arm64": turboVersion,
  "@turbo/windows-64": turboVersion,
  "@turbo/windows-arm64": turboVersion,
});
for (const name of Object.keys(turboLock.optionalDependencies)) {
  const record = rootLock.packages?.[`node_modules/${name}`];
  if (!record) fail(`root lock has no ${name} record`);
  equal(`${name} version`, record.version, turboVersion);
  if (record.optional !== true || record.dev !== true)
    fail(`${name} must remain a dev optional dependency`);
}

if ("remoteCache" in turbo) fail("remote caching is outside S03");
equal("Turbo schema", turbo.$schema, "https://turbo.build/schema.json");
equal("global dependency inputs", turbo.globalDependencies, [
  ".node-version",
  ".nvmrc",
  ".npmrc",
  "package-lock.json",
]);
if (
  !turbo.tasks ||
  typeof turbo.tasks !== "object" ||
  Array.isArray(turbo.tasks)
)
  fail("turbo.json tasks must be an object");

const genericTasks = {
  clean: { cache: false },
  lint: { cache: false, outputs: [] },
  typecheck: { cache: false, outputs: [] },
  test: { cache: false, outputs: [], env: ["CI"] },
  "test:watch": {
    cache: false,
    persistent: true,
    interruptible: true,
    outputs: [],
    env: ["CI"],
  },
  build: {
    dependsOn: ["^build", "clean"],
    cache: false,
    outputs: [],
    env: ["NODE_ENV"],
  },
  pack: {
    dependsOn: ["^build", "build"],
    cache: false,
    outputs: [".artifacts/packages/**"],
  },
  docs: {
    dependsOn: ["^build", "build"],
    cache: false,
    outputs: [],
    env: ["NODE_ENV"],
  },
  e2e: {
    cache: false,
    outputs: ["test-results/**", "playwright-report/**"],
    env: ["CI", "CYPRESS_CACHE_FOLDER", "PLAYWRIGHT_BROWSERS_PATH"],
  },
  "setup:browser": {
    cache: false,
    env: ["CYPRESS_CACHE_FOLDER", "PLAYWRIGHT_BROWSERS_PATH"],
  },
  integration: { cache: false },
  release: { cache: false },
  publish: { cache: false },
};
for (const [name, expected] of Object.entries(genericTasks))
  equal(`generic task ${name}`, turbo.tasks[name], expected);

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveBuildOutputs(directory, manifest) {
  const build = manifest.scripts.build;
  const outputs = new Set();
  const addDirectory = (name) => outputs.add(`${name}/**`);
  let highLevelBuilder = false;
  if (/(?:ng build|ng-packagr|tsdown)/.test(build)) {
    addDirectory("dist");
    highLevelBuilder = true;
  }
  if (/vite build/.test(build)) {
    const viteConfigName = readdirSync(path.join(root, directory)).find(
      (filename) => /^vite\.config\./u.test(filename)
    );
    let outputDirectory = "dist";
    if (viteConfigName) {
      const viteConfig = readFileSync(
        path.join(root, directory, viteConfigName),
        "utf8"
      );
      outputDirectory =
        viteConfig.match(/outDir:\s*['"]([^'"]+)['"]/u)?.[1] || outputDirectory;
    }
    addDirectory(outputDirectory);
    highLevelBuilder = true;
  }
  if (/react-scripts build/.test(build)) {
    addDirectory("build");
    highLevelBuilder = true;
  }
  if (/webpack/.test(build)) {
    highLevelBuilder = true;
    const webpackPath = path.join(root, directory, "webpack.config.js");
    if (!existsSync(webpackPath))
      fail(`${manifest.name} uses webpack without webpack.config.js`);
    const webpack = readFileSync(webpackPath, "utf8");
    if (/[_'"]bundles/.test(webpack)) addDirectory("_bundles");
    else if (/['"]dist['"]/.test(webpack)) addDirectory("dist");
    else {
      const filename = webpack.match(/filename:\s*['"]([^'"]+)['"]/u)?.[1];
      if (!filename)
        fail(`${manifest.name} webpack output is not statically derivable`);
      outputs.add(filename);
    }
  }

  if (!highLevelBuilder) {
    const packageEntries = ["main", "module", "typings", "types"]
      .map((field) => manifest[field])
      .filter((value) => typeof value === "string");
    const buildScripts = Object.entries(manifest.scripts)
      .filter(([name]) => /^(build|compile|bundle|fixmaps(?::|$))/u.test(name))
      .map(([, command]) => command);
    let buildText = [...packageEntries, ...buildScripts].join("\n");
    for (const filename of readdirSync(path.join(root, directory))) {
      if (/(?:rollup|rolldown).*config/u.test(filename)) {
        buildText += `\n${readFileSync(
          path.join(root, directory, filename),
          "utf8"
        )}`;
      }
    }
    const tsconfigPath = path.join(root, directory, "tsconfig.json");
    if (existsSync(tsconfigPath))
      buildText += `\n${readFileSync(tsconfigPath, "utf8")}`;
    for (const generatedDirectory of [
      "lib",
      "lib-esm",
      "_bundles",
      "release",
    ]) {
      const token = regexEscape(generatedDirectory);
      if (
        new RegExp(`(?:^|[/'\"\\s])${token}(?:/|\\*|['\" ,\\s]|$)`, "u").test(
          buildText
        )
      ) {
        addDirectory(generatedDirectory);
      }
    }
  }

  if (outputs.size === 0)
    fail(`${manifest.name} build outputs could not be independently derived`);
  return sorted(outputs);
}

const buildOwners = workspaces.filter(
  ({ manifest }) => manifest.scripts?.build
);
if (buildOwners.length !== 24)
  fail(`expected 24 build-owning workspaces, found ${buildOwners.length}`);
for (const { directory, manifest } of buildOwners) {
  const expected = {
    dependsOn: ["^build", "clean"],
    cache: false,
    outputs: deriveBuildOutputs(directory, manifest),
    env: ["NODE_ENV"],
  };
  equal(
    `${manifest.name} build task`,
    turbo.tasks[`${manifest.name}#build`],
    expected
  );
}

const docsOwners = workspaces.filter(({ manifest }) => manifest.scripts?.docs);
if (docsOwners.length !== 4)
  fail(`expected 4 docs-owning workspaces, found ${docsOwners.length}`);
for (const { manifest } of docsOwners) {
  equal(`${manifest.name} docs task`, turbo.tasks[`${manifest.name}#docs`], {
    dependsOn: ["^build", "build"],
    cache: false,
    outputs: ["_doc/**"],
    env: ["NODE_ENV"],
  });
}

const consumerManifestPaths = new Set(
  aliases.edges.map((edge) => edge.consumer)
);
const sourceTestOwners = workspaces.filter(
  ({ directory, manifest }) =>
    directory === "core" ||
    consumerManifestPaths.has(`${directory}/package.json`)
);
if (sourceTestOwners.length !== 8)
  fail(`expected 8 source-test owners, found ${sourceTestOwners.length}`);
for (const { directory, manifest } of sourceTestOwners) {
  if (!manifest.scripts?.test || !manifest.scripts?.["test:watch"]) {
    fail(`${manifest.name} must own both test and test:watch scripts`);
  }
  const manifestPath = `${directory}/package.json`;
  const watchRoots = sorted(
    new Set(
      aliases.edges
        .filter((edge) => edge.consumer === manifestPath)
        .flatMap((edge) => edge.watchRoots)
    )
  );
  const inputs = [
    "$TURBO_DEFAULT$",
    "$TURBO_ROOT$/migration/source-aliases.json",
    "$TURBO_ROOT$/tools/source-aliases.cjs",
    ...watchRoots.map((watchRoot) => `$TURBO_ROOT$/${watchRoot}/**`),
  ];
  equal(
    `${manifest.name} source test task`,
    turbo.tasks[`${manifest.name}#test`],
    {
      cache: manifest.name !== "@uirouter/core",
      inputs,
      outputs: [],
      env: ["CI"],
    }
  );
  equal(
    `${manifest.name} source watch task`,
    turbo.tasks[`${manifest.name}#test:watch`],
    {
      cache: false,
      persistent: true,
      interruptible: true,
      inputs,
      outputs: [],
      env: ["CI"],
    }
  );
  if (manifest.name === "@uirouter/angularjs") {
    equal(
      "@uirouter/angularjs source typecheck task",
      turbo.tasks["@uirouter/angularjs#typecheck"],
      {
        cache: true,
        inputs,
        outputs: [],
      }
    );
  }
}

const allowedCachedTasks = new Set(
  sourceTestOwners
    .filter(({ manifest }) => manifest.name !== "@uirouter/core")
    .map(({ manifest }) => `${manifest.name}#test`)
    .concat("@uirouter/angularjs#typecheck")
);
for (const [taskName, task] of Object.entries(turbo.tasks)) {
  if (task.cache === true && !allowedCachedTasks.has(taskName))
    fail(`${taskName} is cached without an S03 determinism proof`);
  if (
    (task.persistent ||
      taskName.endsWith("#test:watch") ||
      taskName === "test:watch") &&
    task.cache !== false
  ) {
    fail(`${taskName} persistent/watch task must be uncached`);
  }
  if (
    /(?:^|#)(?:build|docs|e2e|setup:browser|integration|release|publish|pack)$/u.test(
      taskName
    ) &&
    task.cache !== false
  ) {
    fail(`${taskName} must remain uncached in S03`);
  }
}

const knownPackageTaskNames = new Set([
  ...buildOwners.map(({ manifest }) => `${manifest.name}#build`),
  ...docsOwners.map(({ manifest }) => `${manifest.name}#docs`),
  ...sourceTestOwners.flatMap(({ manifest }) => [
    `${manifest.name}#test`,
    `${manifest.name}#test:watch`,
  ]),
  "@uirouter/angularjs#typecheck",
]);
for (const taskName of Object.keys(turbo.tasks).filter((name) =>
  name.includes("#")
)) {
  if (!knownPackageTaskNames.has(taskName))
    fail(`unexpected package-specific task ${taskName}`);
}

let installedGraph = "deferred";
if (process.argv.includes("--installed")) {
  const dryRun = spawnSync(
    path.join(
      root,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "turbo.cmd" : "turbo"
    ),
    [
      "run",
      "build",
      "test",
      "test:watch",
      "typecheck",
      "lint",
      "docs",
      "e2e",
      "--dry=json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
      maxBuffer: 128 * 1024 * 1024,
    }
  );
  if (dryRun.status !== 0)
    fail(`Turbo dry run failed: ${(dryRun.stderr || dryRun.stdout).trim()}`);
  let dry;
  try {
    dry = JSON.parse(dryRun.stdout);
  } catch (error) {
    fail(`Turbo dry run did not return JSON: ${error.message}`);
  }
  const dryTasks = new Map(dry.tasks.map((task) => [task.taskId, task]));
  for (const { manifest } of buildOwners) {
    const taskId = `${manifest.name}#build`;
    const task = dryTasks.get(taskId);
    if (!task) fail(`Turbo dry graph omitted ${taskId}`);
    equal(
      `${taskId} resolved outputs`,
      task.outputs,
      deriveBuildOutputs(workspaceByName.get(manifest.name).directory, manifest)
    );
    const expectedDependencies = new Set([`${manifest.name}#clean`]);
    for (const dependencySection of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const dependencyName of Object.keys(
        manifest[dependencySection] || {}
      )) {
        if (workspaceByName.has(dependencyName))
          expectedDependencies.add(`${dependencyName}#build`);
      }
    }
    equal(
      `${taskId} resolved dependencies`,
      sorted(task.dependencies),
      sorted(expectedDependencies)
    );
  }
  for (const { manifest } of sourceTestOwners) {
    for (const taskSuffix of ["test", "test:watch"]) {
      const taskId = `${manifest.name}#${taskSuffix}`;
      const task = dryTasks.get(taskId);
      if (!task) fail(`Turbo dry graph omitted ${taskId}`);
      if (task.dependencies.length !== 0)
        fail(`${taskId} must not build or run sibling tasks first`);
    }
  }
  installedGraph = "validated";
}

console.log(
  `TURBO_GRAPH_VERIFY_OK workspaces=${workspaces.length} builds=${buildOwners.length} sourceTests=${sourceTestOwners.length} sourceEdges=${aliases.edges.length} docs=${docsOwners.length} cached=${allowedCachedTasks.size} installedGraph=${installedGraph} remoteCache=disabled`
);
