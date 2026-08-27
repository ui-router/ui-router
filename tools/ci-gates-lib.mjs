import crypto from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./validate-migration-contract.mjs";

export const repository = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
);
export const contractPath = "migration/ci-gates.json";
export const schemaPath = "migration/schemas/ci-gates.schema.json";
export const workflowPath = ".github/workflows/ci.yml";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export function sha256File(filename) {
  return sha256(readFileSync(filename));
}
export function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}
function equal(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right))
    throw new Error(`CI_GATES_FAILED: ${label} differs`);
}
function unique(values, label) {
  if (new Set(values).size !== values.length)
    throw new Error(`CI_GATES_FAILED: duplicate ${label}`);
}
function fail(message) {
  throw new Error(`CI_GATES_FAILED: ${message}`);
}
function canonicalize(input, repairs) {
  let current = input;
  const seen = new Set([current]);
  for (const move of repairs.moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) {
      current = `${move.to}${current.slice(move.from.length)}`;
      if (seen.has(current)) fail(`path repair cycle for ${input}`);
      seen.add(current);
    }
  }
  return current;
}
function expectedCoverage(entry) {
  if (entry.id === "angularjs.manifest.root.static")
    return { disposition: "current-waiver", gateIds: ["static-quality"] };
  if (entry.id.startsWith("angular-hybrid.v21."))
    return { disposition: "historical-only", gateIds: ["history"] };
  if (entry.id === "redux.root.install.node10")
    return { disposition: "historical-only", gateIds: ["history"] };
  if (entry.lane === "docs")
    return { disposition: "carried-waiver", gateIds: ["docs"] };
  let gateIds;
  if (entry.lane === "static")
    gateIds = ["layout", "dependency-policy", "static-quality"];
  else if (entry.lane === "install") gateIds = ["install", "dependency-policy"];
  else if (entry.lane === "pack") gateIds = ["packed-consumers"];
  else if (entry.lane === "unit") gateIds = ["source-linked-tests"];
  else if (entry.lane === "build")
    gateIds = entry.source.startsWith("sample-app-")
      ? ["workspace-browser"]
      : ["production-builds"];
  else if (entry.lane === "e2e") gateIds = ["workspace-browser"];
  else if (entry.lane === "downstream") {
    if (["angular-hybrid", "dsr", "sticky-states"].includes(entry.source))
      gateIds = ["workspace-browser"];
    else if (entry.source === "react-hybrid") gateIds = ["isolated-matrix"];
    else if (["angular", "angularjs", "react"].includes(entry.source))
      gateIds = ["isolated-matrix", "workspace-browser"];
    else if (entry.source === "core")
      gateIds = ["source-linked-tests", "isolated-matrix"];
    else fail(`unmapped downstream source ${entry.source}`);
  } else fail(`unmapped baseline lane ${entry.lane}`);
  return {
    disposition:
      entry.result === "waived-failure" ? "final-fixed" : "final-equivalent",
    gateIds,
  };
}
function walk(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      [
        ".git",
        "node_modules",
        ".turbo",
        ".migration-work",
        ".ci-results",
        ".ci-artifacts",
        ".ci-input",
      ].includes(entry.name)
    )
      continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else output.push(absolute);
  }
  return output;
}
function assertCommandPolicy(commands, label) {
  unique(
    commands.map((command) => command.id),
    `${label} command id`
  );
  for (const command of commands) {
    const joined = command.argv.join(" ");
    if (/--(?:force|legacy-peer-deps)\b/.test(joined))
      fail(`${label}/${command.id} bypasses npm peer policy`);
    if (/\b(?:yarn|pnpm|yalc)\b/i.test(joined))
      fail(`${label}/${command.id} uses a non-npm package manager`);
    if (command.argv[0] === "npm" && ["i", "install"].includes(command.argv[1]))
      fail(`${label}/${command.id} uses npm install`);
    if (command.id === "install")
      equal(
        command.argv,
        ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        `${label} install command`
      );
  }
}

export async function validateCiGates(options = {}) {
  const root = options.root ? realpathSync(options.root) : repository;
  const source = options.contract ?? path.join(root, contractPath);
  const contract = JSON.parse(readFileSync(source, "utf8"));
  await validateJsonSchema(contract, path.join(root, schemaPath));

  const bindingFiles = {
    baselinesSha256: "migration/baselines.json",
    packageClassificationSha256: "migration/package-classification.json",
    sourceAliasesSha256: "migration/source-aliases.json",
    packageArtifactsSha256: "migration/package-artifacts.json",
    integrationMatrixSha256: "migration/integration-matrix.json",
    executionLockSha256: "migration/execution-lock.json",
    packageLockSha256: "package-lock.json",
    turboSha256: "turbo.json",
  };
  for (const [field, relative] of Object.entries(bindingFiles)) {
    if (contract.bindings[field] !== sha256File(path.join(root, relative)))
      fail(`${field} binding differs`);
  }

  const execution = readJson(root, "migration/execution-lock.json");
  const matrix = readJson(root, "migration/integration-matrix.json");
  const packageArtifacts = readJson(root, "migration/package-artifacts.json");
  const classification = readJson(
    root,
    "migration/package-classification.json"
  );
  const repairs = readJson(root, "migration/path-repairs.json");
  const aliases = readJson(root, "migration/source-aliases.json");
  const baselines = readJson(root, "migration/baselines.json");
  const turbo = readJson(root, "turbo.json");

  equal(
    contract.runtime.migrationImageDigest,
    execution.toolchain.runtime.osImageDigest,
    "migration image digest"
  );
  equal(contract.runtime.node, matrix.runtime.node, "Node pin");
  equal(contract.runtime.npm, matrix.runtime.npm, "npm pin");
  equal(
    contract.runtime.npmInstallCommand,
    [
      "npm",
      "install",
      "--global",
      "npm@11.17.0",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    "npm provisioning command"
  );
  equal(
    contract.runtime.npmRegistryBootstrapCommand,
    ["node", "tools/bootstrap-ci-registry-tarballs.mjs"],
    "npm registry bootstrap command"
  );
  if (!existsSync(path.join(root, contract.runtime.npmRegistryBootstrapCommand[1])))
    fail("npm registry bootstrap script is missing");
  equal(contract.runtime.turbo, "2.10.12", "Turbo pin");
  if (!contract.runtime.ciImage.endsWith(`@${contract.runtime.ciImageDigest}`))
    fail("CI image reference is not digest pinned");
  equal(
    contract.runtime.browser.package,
    matrix.browser.installerPackage,
    "browser package"
  );
  equal(
    contract.runtime.browser.version,
    matrix.browser.installerVersion,
    "browser package version"
  );
  equal(
    contract.runtime.browser.revision,
    matrix.browser.revision,
    "browser revision"
  );
  equal(
    contract.runtime.browser.versionString,
    matrix.browser.version,
    "browser version string"
  );
  const browserEvidence = readJson(
    root,
    "migration/evidence/i02/run-locks/framework__react__integration__react17.json"
  ).browser;
  const chromium = browserEvidence.executableFiles.find((record) =>
    record.path.endsWith("/chrome")
  );
  equal(
    contract.runtime.browser.executableSha256,
    chromium?.sha256,
    "browser executable digest"
  );
  equal(
    contract.runtime.environment,
    {
      CI: "1",
      HUSKY: "0",
      LC_ALL: "C",
      TZ: "UTC",
      PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      CYPRESS_CACHE_FOLDER: "/root/.cache/Cypress",
      CHROME_BIN: "/ms-playwright/chromium-1234/chrome-linux64/chrome",
    },
    "CI environment"
  );

  const exactActions = {
    checkout: {
      version: "v4.2.2",
      sha: "11bd71901bbe5b1630ceea73d27597364c9af683",
    },
    setupNode: {
      version: "v4.4.0",
      sha: "49933ea5288caeca8642d1e84afbd3f7d6820020",
    },
    uploadArtifact: {
      version: "v4.6.2",
      sha: "ea165f8d65b6e75b540449e92b4886f43607fa02",
    },
    downloadArtifact: {
      version: "v4.3.0",
      sha: "d3f86a106a0bac45b974a628896c90dbdf5c8093",
    },
  };
  equal(contract.actions, exactActions, "action pins");
  equal(
    contract.gateIds,
    [
      "history",
      "layout",
      "install",
      "dependency-policy",
      "static-quality",
      "source-linked-tests",
      "production-builds",
      "packed-consumers",
      "isolated-matrix",
      "workspace-browser",
      "docs",
    ],
    "logical gate ids"
  );

  unique(
    contract.jobs.map((job) => job.id),
    "job id"
  );
  equal(
    contract.jobs.map((job) => job.id),
    ["contracts", "source", "packages", "browser", "docs"],
    "job order"
  );
  const jobById = new Map(contract.jobs.map((job) => [job.id, job]));
  const runtimeCommand = ["node", "tools/verify-ci-runtime.mjs"];
  const installCommand = [
    "npm",
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
  const expectedCommands = {
    contracts: [
      ["runtime", runtimeCommand],
      ["check-locks", ["npm", "run", "verify:locks"]],
      ["check-layout", ["npm", "run", "verify:layout"]],
      ["prove-installs", ["npm", "run", "prove:installs:ci"]],
      ["install", installCommand],
      ["check-static", ["npm", "run", "check:static:installed"]],
      ["test-n04", ["npm", "run", "test:n04-validators"]],
      ["test-n05", ["npm", "run", "test:n05-package-manager"]],
      ["test-s01", ["npm", "run", "test:s01"]],
      ["test-s02", ["npm", "run", "test:source-aliases"]],
      ["test-s03", ["npm", "run", "test:turbo"]],
      ["test-i01", ["npm", "run", "test:isolated"]],
      ["test-p01", ["npm", "run", "test:package-artifacts"]],
      ["test-i02", ["npm", "run", "test:integration-matrix"]],
      ["test-c01", ["npm", "run", "test:ci-gates"]],
      ["test-history", ["npm", "run", "test:history-migration"]],
    ],
    source: [
      ["runtime", runtimeCommand],
      ["install", installCommand],
      [
        "lint",
        [
          "npm",
          "run",
          "lint",
          "--",
          "--filter=!@uirouter/angularjs",
          "--cache=local:",
        ],
      ],
      [
        "angularjs-lint-waiver",
        [
          "node",
          "tools/verify-ci-current-waivers.mjs",
          "--output",
          ".ci-results/source/angularjs-lint-waiver.json",
        ],
      ],
      ["typecheck", ["npm", "run", "typecheck", "--", "--cache=local:"]],
      ["test", ["npm", "run", "test", "--", "--cache=local:"]],
      ["source-commands", ["npm", "run", "prove:source-commands"]],
      ["source-watch", ["npm", "run", "prove:source-watch"]],
      ["source-packs", ["npm", "run", "prove:source-packs"]],
    ],
    packages: [
      ["runtime", runtimeCommand],
      ["install", installCommand],
      ["prove-packages", ["npm", "run", "prove:package-artifacts"]],
      [
        "stage-packages",
        [
          "node",
          "tools/stage-ci-package-artifacts.mjs",
          "--output",
          ".ci-artifacts/packages",
        ],
      ],
      [
        "test-package-input",
        [
          "node",
          "tools/test-ci-package-input.mjs",
          "--input",
          ".ci-artifacts/packages",
        ],
      ],
    ],
    browser: [
      ["runtime", runtimeCommand],
      ...["install", "build", "setup", "e2e", "cleanup"].map((phase) => [
        `stage-${phase}`,
        ["node", "tools/run-workspace-browser.mjs", "--phase", phase],
      ]),
    ],
    docs: [
      ["runtime", runtimeCommand],
      [
        "docs-waivers",
        [
          "node",
          "tools/verify-ci-docs-waivers.mjs",
          "--output",
          ".ci-results/docs/waivers.json",
        ],
      ],
    ],
  };
  for (const job of contract.jobs) {
    assertCommandPolicy(job.commands, job.id);
    equal(
      job.commands.map((command) => [command.id, command.argv]),
      expectedCommands[job.id],
      `${job.id} command contract`
    );
    const installIndex = job.id === "contracts" ? 4 : 1;
    const expectedInstallId =
      job.id === "browser" ? "stage-install" : "install";
    if (
      job.id !== "docs" &&
      job.commands[installIndex].id !== expectedInstallId
    )
      fail(`${job.id} install ordering differs`);
  }

  unique(
    contract.integration.shards.map((shard) => shard.id),
    "integration shard id"
  );
  const runnable = matrix.projects
    .filter((project) => project.mode === "runnable")
    .map((project) => project.id)
    .sort();
  const sharded = contract.integration.shards
    .flatMap((shard) => shard.projectIds)
    .sort();
  unique(sharded, "integration project");
  equal(sharded, runnable, "integration shard coverage");
  for (const shard of contract.integration.shards) {
    assertCommandPolicy(shard.commands, `integration/${shard.id}`);
    equal(
      shard.commands.map((command) => command.id),
      ["runtime", "install", "integration", "verify-integration"],
      `${shard.id} commands`
    );
    const run = shard.commands[2].argv;
    if (
      !run.includes("--artifacts") ||
      !run.includes(contract.integration.inputDirectory)
    )
      fail(`${shard.id} does not consume the producer artifact`);
    const selected = run.flatMap((value, index) =>
      value === "--project" ? [run[index + 1]] : []
    );
    equal(selected, shard.projectIds, `${shard.id} command project coverage`);
    equal(
      shard.commands[0].argv,
      runtimeCommand,
      `${shard.id} runtime command`
    );
    equal(
      shard.commands[1].argv,
      installCommand,
      `${shard.id} install command`
    );
    equal(
      run,
      [
        "node",
        "tools/run-integration-matrix.mjs",
        "--mode",
        "clean",
        "--retain",
        "--artifacts",
        contract.integration.inputDirectory,
        "--output",
        `.migration-work/i02/ci-${shard.id}`,
        ...shard.projectIds.flatMap((projectId) => ["--project", projectId]),
      ],
      `${shard.id} runner command`
    );
    equal(
      shard.commands[3].argv,
      [
        "node",
        "tools/verify-integration-run.mjs",
        "--root",
        `.migration-work/i02/ci-${shard.id}`,
      ],
      `${shard.id} verifier command`
    );
  }
  equal(
    contract.aggregate,
    {
      id: "required",
      needs: [
        "contracts",
        "source",
        "packages",
        "integration",
        "browser",
        "docs",
      ],
      requireResult: "success",
    },
    "aggregate contract"
  );

  const expectedArtifacts = packageArtifacts.packages
    .map((record) => record.id)
    .sort();
  equal(
    contract.artifacts.packages.artifactIds,
    expectedArtifacts,
    "producer artifact ids"
  );
  equal(
    contract.artifacts.packages.integrationArtifactIds,
    matrix.artifactPolicy.artifactIds.slice().sort(),
    "integration artifact ids"
  );
  if (
    !contract.artifacts.packages.includeHiddenFiles ||
    contract.artifacts.packages.compressionLevel !== 0
  )
    fail("package artifact upload policy differs");

  const records = classification.manifests.map((record) => ({
    ...record,
    currentPath: canonicalize(record.path, repairs),
  }));
  const browserWorkspaces = [];
  let sourceTests = 0;
  let buildOwners = 0;
  for (const record of records) {
    const manifest = readJson(root, record.currentPath);
    if (record.workspace && typeof manifest.scripts?.build === "string")
      buildOwners += 1;
    if (record.published && typeof manifest.scripts?.test === "string")
      sourceTests += 1;
    if (
      record.class === "example" &&
      record.workspace &&
      manifest.scripts?.e2e &&
      manifest.scripts?.["setup:browser"]
    )
      browserWorkspaces.push(record.finalName);
  }
  equal(
    contract.browserWorkspaces,
    browserWorkspaces.sort(),
    "ordinary browser workspaces"
  );
  if (sourceTests !== 8 || aliases.edges.length !== 19 || buildOwners !== 24)
    fail(
      `derived source/build counts differ: source=${sourceTests} edges=${aliases.edges.length} build=${buildOwners}`
    );

  unique(
    contract.baselineCoverage.map((record) => record.baselineId),
    "baseline coverage id"
  );
  const coverageById = new Map(
    contract.baselineCoverage.map((record) => [record.baselineId, record])
  );
  equal(
    [...coverageById.keys()].sort(),
    baselines.entries.map((entry) => entry.id).sort(),
    "baseline coverage set"
  );
  for (const entry of baselines.entries) {
    const coverage = coverageById.get(entry.id);
    const expected = expectedCoverage(entry);
    equal(
      { disposition: coverage.disposition, gateIds: coverage.gateIds },
      expected,
      `${entry.id} coverage`
    );
    for (const gate of coverage.gateIds)
      if (!contract.gateIds.includes(gate))
        fail(`${entry.id} references unknown gate ${gate}`);
  }

  const expectedDocs = baselines.entries
    .filter((entry) => entry.lane === "docs")
    .map((entry) => ({
      baselineId: entry.id,
      evidence: entry.evidence,
      waiver: entry.waiver,
    }))
    .sort((a, b) => a.baselineId.localeCompare(b.baselineId));
  equal(contract.docsWaivers, expectedDocs, "docs waivers");
  for (const record of contract.docsWaivers) {
    if (
      !record.waiver ||
      Date.parse(`${record.waiver.expires}T23:59:59Z`) <= Date.now()
    )
      fail(`${record.baselineId} waiver is missing or expired`);
  }
  const react16 = matrix.projects.find(
    (project) => project.id === "framework/react-hybrid/integration/react16"
  );
  equal(
    contract.currentWaivers,
    [
      {
        id: react16.waiver.baselineId,
        projectId: react16.id,
        ...react16.waiver,
      },
      {
        id: "angularjs-eslint-root-resolution",
        projectId: "frameworks/angularjs/uirouter-angularjs",
        baselineId: "angularjs.manifest.root.static",
        owner: "ui-router-maintainers",
        reason:
          "The legacy AngularJS ESLint 7 and @typescript-eslint 3 lane resolves hoisted experimental utilities against root ESLint 8 and fails before linting. Other lint tasks remain active; no override or peer bypass is applied.",
        trackingIssue: "https://github.com/ui-router/ui-router/issues/22",
        expires: "2026-10-31",
      },
    ],
    "current waiver set"
  );
  for (const waiver of contract.currentWaivers)
    if (Date.parse(`${waiver.expires}T23:59:59Z`) <= Date.now())
      fail(`${waiver.id} waiver is expired`);

  const expectedCounts = {
    baselineRecords: baselines.entries.length,
    baselineWaivers: baselines.entries.filter(
      (entry) => entry.result === "waived-failure"
    ).length,
    logicalGates: contract.gateIds.length,
    executableJobs: contract.jobs.length + 1,
    integrationShards: contract.integration.shards.length,
    integrationProjects: runnable.length,
    integrationTemplates: matrix.projects.filter(
      (project) => project.mode === "template"
    ).length,
    packageArtifacts: expectedArtifacts.length,
    sourceTestPackages: sourceTests,
    sourceEdges: aliases.edges.length,
    buildOwners,
    ordinaryExamples: records.filter((record) => record.class === "example")
      .length,
    ordinaryBrowserProjects: browserWorkspaces.length,
    docsWaivers: expectedDocs.length,
  };
  equal(contract.counts, expectedCounts, "derived counts");

  const activeAutomation = walk(root)
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter(
      (file) =>
        (file.startsWith(".github/workflows/") && /\.ya?ml$/.test(file)) ||
        /(^|\/)\.travis\.ya?ml$/.test(file)
    );
  const expectedWorkflow =
    options.workflow ?? path.join(root, contract.workflow.path);
  if (existsSync(expectedWorkflow)) {
    const relative = path
      .relative(root, expectedWorkflow)
      .split(path.sep)
      .join("/");
    const expectedActive = options.workflow
      ? activeAutomation
      : [contract.workflow.path];
    if (!options.workflow)
      equal(activeAutomation, expectedActive, "active workflow inventory");
    if (lstatSync(expectedWorkflow).isSymbolicLink())
      fail("CI workflow is a symbolic link");
    void relative;
  }
  if (
    !("tasks" in turbo) ||
    /TURBO_(?:TOKEN|TEAM)/.test(canonicalJson(contract))
  )
    fail("Turbo graph or remote-cache policy differs");
  return {
    root,
    contract,
    baselines,
    matrix,
    packageArtifacts,
    classification,
    repairs,
    aliases,
  };
}
