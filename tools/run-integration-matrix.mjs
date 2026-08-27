#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  assertExternalSandbox,
  assertNoLinksOrSharedFiles,
  canonicalJson,
  fixtureTreeSha256,
  installedExternalGraph,
  matrixPath,
  repository,
  runLockSchemaPath,
  sha256,
  sha256File,
  validateIntegrationMatrix,
} from "./integration-matrix-lib.mjs";
import { validateJsonSchema } from "./validate-migration-contract.mjs";

function die(message) {
  throw new Error(`INTEGRATION_RUN_FAILED: ${message}`);
}
function values(name) {
  const output = [];
  for (let index = 0; index < process.argv.length; index += 1)
    if (process.argv[index] === name) output.push(process.argv[index + 1]);
  return output;
}
function value(name) {
  const found = values(name);
  if (found.length > 1) die(`${name} may appear once`);
  return found[0] ?? null;
}
const knownValueArguments = new Set([
  "--project",
  "--mode",
  "--cache-root",
  "--output",
]);
const knownFlags = new Set(["--reset", "--retain", "--write"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (knownValueArguments.has(argument)) {
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--"))
      die(`${argument} requires a value`);
    index += 1;
  } else if (!knownFlags.has(argument)) die(`unknown argument ${argument}`);
}
const mode = value("--mode") ?? "clean";
if (!new Set(["clean", "reuse"]).has(mode)) die(`unsupported mode ${mode}`);
const resetRequested = process.argv.includes("--reset");
const retain = process.argv.includes("--retain");
const writeEvidence = process.argv.includes("--write");
const cacheArgument = value("--cache-root");
if (mode === "reuse" && !cacheArgument)
  die("reuse mode requires --cache-root outside repository ancestry");
if (mode === "clean" && (cacheArgument || resetRequested))
  die("--cache-root and --reset are reuse-only");

const validated = await validateIntegrationMatrix();
const { matrix, packageArtifacts, artifactById, publishedNames } = validated;
if (process.version !== `v${matrix.runtime.node}`)
  die(`Node ${matrix.runtime.node} required, got ${process.version}`);
const npmVersion = spawnSync("npm", ["--version"], { encoding: "utf8" });
if (npmVersion.status !== 0 || npmVersion.stdout.trim() !== matrix.runtime.npm)
  die(`npm ${matrix.runtime.npm} required, got ${npmVersion.stdout.trim()}`);

const requestedIds = values("--project");
const runnable = matrix.projects.filter(
  (project) => project.mode === "runnable"
);
const selected = requestedIds.length
  ? requestedIds.map((id) => {
      const project = matrix.projects.find((candidate) => candidate.id === id);
      if (!project) die(`unknown project ${id}`);
      if (project.mode !== "runnable") die(`${id} is a lockless template`);
      return project;
    })
  : runnable;
if (new Set(selected.map((project) => project.id)).size !== selected.length)
  die("duplicate --project selection");

const outputRoot = path.resolve(
  value("--output") ?? path.join(repository, ".migration-work/i02/latest")
);
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
const cacheRoot = cacheArgument ? path.resolve(cacheArgument) : null;
if (cacheRoot) {
  mkdirSync(cacheRoot, { recursive: true });
  assertExternalSandbox(repository, cacheRoot);
}
const cleanRoot =
  mode === "clean"
    ? mkdtempSync(path.join(realpathSync(os.tmpdir()), "uirouter-i02-clean-"))
    : null;
const runRoot = mode === "clean" ? cleanRoot : realpathSync(cacheRoot);
assertExternalSandbox(repository, runRoot);
mkdirSync(path.join(runRoot, "artifacts"), { recursive: true });
mkdirSync(path.join(runRoot, "npm-cache"), { recursive: true });
mkdirSync(path.join(runRoot, "browser-cache"), { recursive: true });

const environment = { ...process.env, ...matrix.runtime.environment };
for (const key of matrix.runtime.forbiddenEnvironment) delete environment[key];
environment.npm_config_cache = path.join(runRoot, "npm-cache");
environment.npm_config_registry = matrix.networkPolicy.registry;
environment.PLAYWRIGHT_BROWSERS_PATH = path.join(runRoot, "browser-cache");

const commandResult = (argv, cwd, env = environment) => {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error)
    die(`${argv.join(" ")} failed to start: ${result.error.message}`);
  return result;
};
const requiredCommand = (argv, cwd, label) => {
  const result = commandResult(argv, cwd);
  if (result.status !== 0)
    die(`${label} failed (${result.status})\n${result.stdout}${result.stderr}`);
  return result;
};

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0)
    die(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const repositoryState = {
  commit: gitOutput(["rev-parse", "HEAD"]),
  tree: gitOutput(["rev-parse", "HEAD^{tree}"]),
  dirty: Boolean(gitOutput(["status", "--porcelain"])),
  sourceSnapshotSha256: sha256(
    `${gitOutput(["ls-files", "-s"])}\n${gitOutput(["diff", "--binary"])}\n`
  ),
};

const sentinelPath = path.join(
  repository,
  "node_modules",
  ...matrix.sandboxPolicy.sentinelPackage.split("/")
);
if (existsSync(sentinelPath))
  die(`pre-existing root-only sentinel must not be mutated: ${sentinelPath}`);
let sentinelCreated = false;
function createSentinel() {
  if (existsSync(sentinelPath))
    die(`root-only sentinel appeared before creation: ${sentinelPath}`);
  mkdirSync(sentinelPath, { recursive: true });
  writeFileSync(
    path.join(sentinelPath, "package.json"),
    `${JSON.stringify(
      {
        name: matrix.sandboxPolicy.sentinelPackage,
        version: "0.0.0-i02-sentinel",
        main: "index.js",
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    path.join(sentinelPath, "index.js"),
    "module.exports = 'root-only';\n"
  );
  sentinelCreated = true;
}
function removeSentinel() {
  if (sentinelCreated) {
    rmSync(sentinelPath, { recursive: true, force: true });
    const scope = path.dirname(sentinelPath);
    if (existsSync(scope) && readdirSync(scope).length === 0) rmSync(scope);
    sentinelCreated = false;
  }
}

function treeRecords(directory, ignored = new Set()) {
  const records = [];
  function walk(absolute, relative = "") {
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      if (ignored.has(entry.name)) continue;
      const child = path.join(absolute, entry.name);
      const portable = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) die(`tree contains symlink ${child}`);
      if (entry.isDirectory()) walk(child, portable);
      else if (entry.isFile()) {
        const contents = readFileSync(child);
        records.push({
          path: portable,
          size: contents.length,
          sha256: sha256(contents),
        });
      } else die(`tree contains unsupported entry ${child}`);
    }
  }
  walk(directory);
  return records;
}
function directorySha256(directory, ignored) {
  return sha256(canonicalJson(treeRecords(directory, ignored)));
}

function collectArtifacts() {
  requiredCommand(
    matrix.artifactPolicy.producerCommand,
    repository,
    "P01 artifact producer"
  );
  const records = [];
  for (const artifactId of matrix.artifactPolicy.artifactIds) {
    const contractRecord = artifactById.get(artifactId);
    const packageRoot = path.join(
      repository,
      path.posix.dirname(contractRecord.manifest)
    );
    const sourceDirectory = path.join(
      packageRoot,
      matrix.artifactPolicy.metadataDirectoryName
    );
    const names = readdirSync(sourceDirectory).sort();
    const metadataName = names.find((name) => name.endsWith(".json"));
    const tarballName = names.find((name) => name.endsWith(".tgz"));
    if (
      !metadataName ||
      !tarballName ||
      names.filter((name) => name.endsWith(".json")).length !== 1 ||
      names.filter((name) => name.endsWith(".tgz")).length !== 1
    )
      die(`${artifactId}: producer did not emit one metadata file and tarball`);
    const metadataPath = path.join(sourceDirectory, metadataName);
    const metadataBytes = readFileSync(metadataPath);
    const metadata = JSON.parse(metadataBytes);
    const sourceTarball = path.join(sourceDirectory, tarballName);
    if (
      metadata.artifactId !== artifactId ||
      metadata.package !== contractRecord.package ||
      metadata.version !== contractRecord.version ||
      metadata.filename !== tarballName ||
      sha256File(sourceTarball) !== metadata.sha256 ||
      !tarballName.includes(`-sha256-${metadata.sha256}.tgz`)
    )
      die(`${artifactId}: P01 artifact metadata differs`);
    const destination = path.join(runRoot, "artifacts", tarballName);
    cpSync(sourceTarball, destination, { force: true });
    const sourceStat = statSync(sourceTarball);
    const destinationStat = statSync(destination);
    if (
      sourceStat.dev === destinationStat.dev &&
      sourceStat.ino === destinationStat.ino
    )
      die(`${artifactId}: artifact staging used a hard link`);
    if (sha256File(destination) !== metadata.sha256)
      die(`${artifactId}: staged artifact digest differs`);
    records.push({
      artifactId,
      package: metadata.package,
      version: metadata.version,
      filename: tarballName,
      path: destination,
      sha256: metadata.sha256,
      integrity: metadata.integrity,
      metadataSha256: sha256(metadataBytes),
      filesSha256: sha256(canonicalJson(metadata.files)),
    });
  }
  records.sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId)
  );
  writeFileSync(
    path.join(runRoot, "artifacts", "hashes.json"),
    `${JSON.stringify(records, null, 2)}\n`
  );
  return records;
}

function copyFixture(project, projectRoot) {
  const source = path.join(repository, path.posix.dirname(project.manifest));
  const destination = path.join(projectRoot, "project");
  cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (filename) => {
      const name = path.basename(filename);
      return !new Set([
        "node_modules",
        "dist",
        "coverage",
        ".cache",
        ".turbo",
      ]).has(name);
    },
  });
  assertExternalSandbox(repository, projectRoot);
  const linkScanSha256 = assertNoLinksOrSharedFiles(source, destination);
  return { source, destination, linkScanSha256 };
}

function stageManifest(project, projectDirectory, artifactMap) {
  const manifestPath = path.join(projectDirectory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const changed = [];
  for (const rewrite of project.rewrites) {
    const artifact = artifactMap.get(rewrite.artifactId);
    if (!artifact || artifact.package !== rewrite.package)
      die(`${project.id}: artifact mismatch for ${rewrite.id}`);
    if (!manifest[rewrite.manifestSection])
      manifest[rewrite.manifestSection] = {};
    const before = manifest[rewrite.manifestSection][rewrite.package];
    if (
      rewrite.operation === "replace-declared" &&
      before !== rewrite.declaredSpec
    )
      die(`${project.id}: declaration changed before staging ${rewrite.id}`);
    if (rewrite.operation === "inject-legacy" && before !== undefined)
      die(
        `${project.id}: legacy-only package already declared ${rewrite.package}`
      );
    const relative = path
      .relative(projectDirectory, artifact.path)
      .split(path.sep)
      .join("/");
    if (relative.startsWith("/") || !relative.endsWith(artifact.filename))
      die(`${project.id}: invalid artifact relative path ${relative}`);
    manifest[rewrite.manifestSection][rewrite.package] = `file:${relative}`;
    changed.push({
      rewriteId: rewrite.id,
      section: rewrite.manifestSection,
      package: rewrite.package,
      before: before ?? null,
      after: `file:${relative}`,
    });
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const original = JSON.parse(
    readFileSync(path.join(repository, project.manifest), "utf8")
  );
  const expected = structuredClone(original);
  for (const change of changed) {
    if (!expected[change.section]) expected[change.section] = {};
    expected[change.section][change.package] = change.after;
  }
  if (canonicalJson(manifest) !== canonicalJson(expected))
    die(`${project.id}: staged manifest has undeclared changes`);
  return { manifestPath, manifest, changed };
}

function sandboxModuleAudit(projectDirectory, temporaryLock) {
  const records = [];
  for (const [key, entry] of Object.entries(temporaryLock.packages)) {
    if (!key || !key.includes("node_modules/")) continue;
    const installed = path.join(projectDirectory, ...key.split("/"));
    if (!existsSync(installed)) {
      if (entry.optional) continue;
      die(`installed lock entry is missing: ${key}`);
    }
    const info = lstatSync(installed);
    if (info.isSymbolicLink()) die(`installed dependency is a symlink: ${key}`);
    const real = realpathSync(installed);
    const relative = path.relative(projectDirectory, real);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      die(`installed dependency escapes sandbox: ${key} -> ${real}`);
    records.push({ key, realpath: real, version: entry.version ?? null });
  }
  return records.sort((left, right) => left.key.localeCompare(right.key));
}

function nodeModulesSha256(projectDirectory) {
  const root = path.join(projectDirectory, "node_modules");
  const records = [];
  function walk(directory, relative = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name)
    )) {
      const absolute = path.join(directory, entry.name);
      const portable = path.posix.join(relative, entry.name);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        const resolved = realpathSync(absolute);
        const fromRoot = path.relative(root, resolved);
        if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot))
          die(
            `node_modules symlink escapes sandbox: ${portable} -> ${resolved}`
          );
        records.push({
          path: portable,
          symlink: path
            .relative(path.dirname(absolute), resolved)
            .split(path.sep)
            .join("/"),
        });
      } else if (info.isDirectory()) walk(absolute, portable);
      else if (info.isFile()) {
        const contents = readFileSync(absolute);
        records.push({
          path: portable,
          size: contents.length,
          sha256: sha256(contents),
        });
      } else die(`node_modules contains unsupported entry ${portable}`);
    }
  }
  walk(root);
  return sha256(canonicalJson(records));
}

function verifyBrowserInstall(
  projectDirectory,
  temporaryLock,
  { cacheRequired }
) {
  const core = temporaryLock.packages["node_modules/playwright-core"];
  const descriptor = path.join(
    projectDirectory,
    "node_modules/playwright-core/browsers.json"
  );
  if (
    !core ||
    core.version !== matrix.browser.installerVersion ||
    core.integrity !== matrix.browser.coreIntegrity ||
    !existsSync(descriptor) ||
    sha256File(descriptor) !== matrix.browser.browsersJsonSha256
  )
    die("installed Playwright browser descriptor differs from the matrix");
  if (cacheRequired) {
    const names = readdirSync(path.join(runRoot, "browser-cache"));
    for (const expected of [
      `${matrix.browser.name}-${matrix.browser.revision}`,
      `${matrix.browser.name}_headless_shell-${matrix.browser.revision}`,
    ])
      if (!names.includes(expected))
        die(`browser cache is missing ${expected}`);
  }
}

function sentinelProbe(projectDirectory) {
  const resolver = createRequire(path.join(projectDirectory, "package.json"));
  try {
    resolver.resolve(matrix.sandboxPolicy.sentinelPackage);
    die(
      `${matrix.sandboxPolicy.sentinelPackage} resolved from external sandbox`
    );
  } catch (error) {
    if (String(error.message).startsWith("INTEGRATION_RUN_FAILED")) throw error;
  }
  return {
    package: matrix.sandboxPolicy.sentinelPackage,
    checkoutPath: sentinelPath,
    preexisting: false,
    resolved: false,
  };
}

function projectSlug(id) {
  return id.replaceAll("/", "__").replaceAll(/[^A-Za-z0-9_.-]/g, "-");
}
function installCommandAdapter(project, projectRoot) {
  const adapter = matrix.commandAdapters.find((candidate) =>
    candidate.allowedProjects.includes(project.id)
  );
  if (!adapter) return null;
  const shimDirectory = path.join(projectRoot, "command-adapters");
  mkdirSync(shimDirectory, { recursive: true });
  const source = path.join(repository, adapter.script);
  const target = path.join(shimDirectory, adapter.invokedAs);
  cpSync(source, target, { force: true });
  const sourceStat = statSync(source);
  const targetStat = statSync(target);
  if (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
    die(`${project.id}: command adapter was hard-linked`);
  if (sha256File(target) !== adapter.scriptSha256)
    die(`${project.id}: command adapter digest differs`);
  chmodSync(target, targetStat.mode | 0o111);
  return { adapter, shimDirectory, target };
}
function stepRecord(id, argv, result, logsDirectory) {
  mkdirSync(logsDirectory, { recursive: true });
  const stdoutPath = path.join(logsDirectory, `${id}.stdout.log`);
  const stderrPath = path.join(logsDirectory, `${id}.stderr.log`);
  writeFileSync(stdoutPath, result.stdout ?? "");
  writeFileSync(stderrPath, result.stderr ?? "");
  return {
    id,
    argv,
    status: result.status ?? -1,
    stdoutSha256: sha256(result.stdout ?? ""),
    stderrSha256: sha256(result.stderr ?? ""),
  };
}

function commandSha256(argv) {
  return sha256(canonicalJson(argv));
}
function npmConfigSha256() {
  return sha256(
    canonicalJson({
      repositoryNpmrcSha256: sha256File(path.join(repository, ".npmrc")),
      registry: matrix.networkPolicy.registry,
      cache: environment.npm_config_cache,
      ignoreScripts: true,
      lockArgv: matrix.lockPolicy.lockArgv,
      installArgv: matrix.lockPolicy.installArgv,
    })
  );
}
function gitFixtureGuard(project) {
  if (
    sha256File(path.join(repository, project.manifest)) !==
    project.committedManifestSha256
  )
    die(`${project.id}: committed manifest changed during run`);
  if (
    project.committedLock &&
    sha256File(path.join(repository, project.committedLock.path)) !==
      project.committedLock.sha256
  )
    die(`${project.id}: committed lock changed during run`);
  if (
    fixtureTreeSha256(repository, project.manifest) !==
    project.fixtureTreeSha256
  )
    die(`${project.id}: committed fixture tree changed during run`);
}

function resetInputs(project, artifacts, graphs = null) {
  const value = {
    fixtureTree: project.fixtureTreeSha256,
    committedLock: project.committedLock.sha256,
    matrix: sha256File(path.join(repository, matrixPath)),
    repositoryRevision: repositoryState,
    platformArchitecture: `${process.platform}/${process.arch}`,
    nodeNpm: `${process.version}/${matrix.runtime.npm}`,
    npmConfiguration: npmConfigSha256(),
    browser: project.browser ? matrix.browser : null,
    tarballs: artifacts
      .filter((artifact) =>
        project.rewrites.some(
          (rewrite) => rewrite.artifactId === artifact.artifactId
        )
      )
      .map(({ artifactId, sha256: digest }) => ({
        artifactId,
        sha256: digest,
      })),
    packageArtifactsContract: matrix.packageArtifactsSha256,
    baselinesRuntime: {
      baselines: matrix.baselinesSha256,
      runtime: matrix.runtime,
    },
    externalGraph: {
      before: project.externalGraph,
      expectedAfterSha256: project.expectedExternalGraphSha256,
      allowedChanges: project.allowedExternalGraphChanges,
    },
    installedDependencyGraph: graphs?.installedSha256 ?? "pending",
    peerGraph: graphs?.peerSha256 ?? "pending",
    command: {
      selected: ["npm", "run", project.commands.selected],
      adapters: matrix.commandAdapters.filter((adapter) =>
        adapter.allowedProjects.includes(project.id)
      ),
    },
  };
  return { value, sha256: sha256(canonicalJson(value)) };
}

function writeFailureBundle(project, projectOutput, projectRoot, state, error) {
  const bundle = path.join(projectOutput, "failure-bundle");
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  const files = new Map();
  const addBytes = (name, relative, bytes) => {
    const target = path.join(bundle, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.set(name, relative);
  };
  const addSource = (name, relative, source) => {
    if (source && existsSync(source))
      addBytes(name, relative, readFileSync(source));
    else addBytes(name, relative, Buffer.from("not-produced\n"));
  };
  addSource(
    "original-manifest",
    "original/package.json",
    path.join(repository, project.manifest)
  );
  addSource(
    "original-lock-or-absence",
    "original/package-lock.json",
    project.committedLock
      ? path.join(repository, project.committedLock.path)
      : null
  );
  addSource("staged-manifest", "staged/package.json", state.manifestPath);
  addSource("temporary-lock", "staged/package-lock.json", state.lockPath);
  addBytes(
    "matrix-entry",
    "matrix-entry.json",
    Buffer.from(`${JSON.stringify(project, null, 2)}\n`)
  );
  addBytes(
    "run-lock",
    "run-lock.json",
    Buffer.from(`${JSON.stringify(state.runLock, null, 2)}\n`)
  );
  const archiveDirectory = path.join(bundle, "artifacts");
  mkdirSync(archiveDirectory, { recursive: true });
  for (const artifact of state.artifacts ?? [])
    cpSync(artifact.path, path.join(archiveDirectory, artifact.filename));
  files.set("artifact-archives", "artifacts");
  addSource(
    "artifact-hash-manifest",
    "artifacts/hashes.json",
    path.join(runRoot, "artifacts/hashes.json")
  );
  addBytes(
    "toolchain-config",
    "toolchain.json",
    Buffer.from(
      `${JSON.stringify(
        {
          runtime: matrix.runtime,
          browser: matrix.browser,
          lockPolicy: matrix.lockPolicy,
          commandAdapters: matrix.commandAdapters,
          environment: Object.fromEntries(
            Object.entries(state.selectedEnvironment ?? environment).filter(
              ([key]) =>
                [
                  "CI",
                  "HUSKY",
                  "LC_ALL",
                  "TZ",
                  "PLAYWRIGHT_BROWSERS_PATH",
                  "npm_config_cache",
                  "npm_config_registry",
                  "I02_COMMAND_ADAPTER_PATH",
                ].includes(key)
            )
          ),
        },
        null,
        2
      )}\n`
    )
  );
  addBytes(
    "dependency-graph",
    "dependency-graph.json",
    Buffer.from(
      `${JSON.stringify(state.graphs ?? { status: "not-produced" }, null, 2)}\n`
    )
  );
  addBytes(
    "origin-audit",
    "origin-audit.json",
    Buffer.from(`${JSON.stringify(state.origins ?? [], null, 2)}\n`)
  );
  addBytes(
    "ancestry-link-scan",
    "ancestry-link-scan.json",
    Buffer.from(
      `${JSON.stringify(
        state.linkScan ?? { status: "not-produced" },
        null,
        2
      )}\n`
    )
  );
  addBytes(
    "sentinel-probe",
    "sentinel-probe.json",
    Buffer.from(
      `${JSON.stringify(
        state.sentinel ?? { status: "not-produced" },
        null,
        2
      )}\n`
    )
  );
  addBytes(
    "exact-command",
    "command.json",
    Buffer.from(`${JSON.stringify(state.currentCommand ?? null, null, 2)}\n`)
  );
  const lastStep = state.steps?.at(-1);
  addSource(
    "stdout",
    "command.stdout.log",
    lastStep
      ? path.join(projectOutput, "logs", `${lastStep.id}.stdout.log`)
      : null
  );
  addSource(
    "stderr",
    "command.stderr.log",
    lastStep
      ? path.join(projectOutput, "logs", `${lastStep.id}.stderr.log`)
      : null
  );
  addBytes(
    "replay-reset-commands",
    "replay-reset.json",
    Buffer.from(
      `${JSON.stringify(
        {
          replay: [
            "node",
            "tools/run-integration-matrix.mjs",
            "--mode",
            mode,
            "--project",
            project.id,
            ...(cacheRoot ? ["--cache-root", cacheRoot] : []),
            "--retain",
          ],
          reset: [
            "node",
            "tools/run-integration-matrix.mjs",
            "--mode",
            "reuse",
            "--project",
            project.id,
            "--cache-root",
            cacheRoot ?? "<external-cache-root>",
            "--reset",
          ],
        },
        null,
        2
      )}\n`
    )
  );
  addBytes(
    "failure",
    "failure.json",
    Buffer.from(
      `${JSON.stringify(
        { message: error.message, retainedSandbox: projectRoot },
        null,
        2
      )}\n`
    )
  );
  const contents = matrix.failureBundleContents.map((name) => {
    const relative = files.get(name);
    if (!relative) die(`failure bundle did not create ${name}`);
    const absolute = path.join(bundle, relative);
    const digest = statSync(absolute).isDirectory()
      ? directorySha256(absolute)
      : sha256File(absolute);
    return { name, path: relative, sha256: digest };
  });
  return { path: bundle, sha256: sha256(canonicalJson(contents)), contents };
}

function incompleteOrigin(project, rewrite, edgeId, reason) {
  return {
    status: "unavailable",
    edgeId,
    package: rewrite.package,
    expectedVersion: rewrite.expectedVersion,
    artifactId: rewrite.artifactId,
    reason,
  };
}

const artifacts = collectArtifacts();
const artifactMap = new Map(
  artifacts.map((record) => [record.artifactId, record])
);
const evidenceArtifactDirectory = path.join(outputRoot, "artifacts");
mkdirSync(evidenceArtifactDirectory, { recursive: true });
const evidenceArtifacts = artifacts.map((artifact) => {
  const target = path.join(evidenceArtifactDirectory, artifact.filename);
  cpSync(artifact.path, target, { force: true });
  if (sha256File(target) !== artifact.sha256)
    die(`${artifact.artifactId}: evidence artifact digest differs`);
  return {
    ...artifact,
    path: path.relative(outputRoot, target).split(path.sep).join("/"),
  };
});
writeFileSync(
  path.join(evidenceArtifactDirectory, "hashes.json"),
  `${JSON.stringify(evidenceArtifacts, null, 2)}\n`
);
createSentinel();
let browserInstallSha256 = null;
const results = [];
let runFailed = false;
try {
  for (const project of selected) {
    gitFixtureGuard(project);
    const slug = projectSlug(project.id);
    const projectRoot = path.join(runRoot, "projects", slug);
    const projectOutput = path.join(outputRoot, "projects", slug);
    mkdirSync(projectOutput, { recursive: true });
    const state = { artifacts, steps: [], origins: [], graphs: null };
    const statePath = path.join(projectRoot, "state.json");
    const previous = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, "utf8"))
      : null;
    let resetState = resetInputs(project, artifacts, previous?.graphs);
    writeFileSync(
      path.join(projectOutput, "reset-inputs.json"),
      `${JSON.stringify(
        { value: resetState.value, sha256: resetState.sha256 },
        null,
        2
      )}\n`
    );
    let reused = false;
    try {
      if (mode === "reuse" && previous && !resetRequested) {
        if (previous.resetInputsSha256 !== resetState.sha256)
          die(
            `${project.id}: reusable state is stale (${previous.resetInputsSha256} != ${resetState.sha256}); rerun with --reset`
          );
        reused = true;
      } else {
        rmSync(projectRoot, { recursive: true, force: true });
        mkdirSync(projectRoot, { recursive: true });
        const copied = copyFixture(project, projectRoot);
        state.linkScan = {
          source: copied.source,
          copy: copied.destination,
          sha256: copied.linkScanSha256,
          outsideRepositoryAncestry: true,
        };
        state.projectDirectory = copied.destination;
        state.commandAdapter = installCommandAdapter(project, projectRoot);
        const staged = stageManifest(project, copied.destination, artifactMap);
        state.manifestPath = staged.manifestPath;
        state.currentCommand = matrix.lockPolicy.lockArgv;
        let result = commandResult(
          matrix.lockPolicy.lockArgv,
          copied.destination
        );
        state.steps.push(
          stepRecord(
            "lock",
            matrix.lockPolicy.lockArgv,
            result,
            path.join(projectOutput, "logs")
          )
        );
        if (result.status !== 0)
          die(
            `${project.id}: temporary lock generation failed (${result.status})`
          );
        state.lockPath = path.join(copied.destination, "package-lock.json");
        const temporaryLock = JSON.parse(readFileSync(state.lockPath, "utf8"));
        const afterExternal = installedExternalGraph(
          temporaryLock,
          publishedNames
        );
        if (afterExternal.sha256 !== project.expectedExternalGraphSha256)
          die(
            `${project.id}: staged external dependency graph differs from the exact allowed changes`
          );
        state.currentCommand = matrix.lockPolicy.installArgv;
        result = commandResult(
          matrix.lockPolicy.installArgv,
          copied.destination
        );
        state.steps.push(
          stepRecord(
            "install",
            matrix.lockPolicy.installArgv,
            result,
            path.join(projectOutput, "logs")
          )
        );
        if (result.status !== 0)
          die(`${project.id}: npm ci failed (${result.status})`);
        const moduleAudit = sandboxModuleAudit(
          copied.destination,
          temporaryLock
        );
        state.sentinel = sentinelProbe(copied.destination);
        const lsArgv = ["npm", "ls", "--all", "--json"];
        state.currentCommand = lsArgv;
        result = commandResult(lsArgv, copied.destination);
        state.steps.push(
          stepRecord("npm-ls", lsArgv, result, path.join(projectOutput, "logs"))
        );
        if (result.status !== 0)
          die(`${project.id}: npm ls failed (${result.status})`);
        const installedGraph = JSON.parse(result.stdout);
        const origins = [];
        for (const rewrite of project.rewrites) {
          const artifact = artifactMap.get(rewrite.artifactId);
          const key = `node_modules/${rewrite.package}`;
          const lockEntry = temporaryLock.packages[key];
          const installedPath = path.join(
            copied.destination,
            ...key.split("/")
          );
          if (!lockEntry || !existsSync(installedPath))
            die(
              `${project.id}: internal package is missing ${rewrite.package}`
            );
          const packageManifestPath = path.join(installedPath, "package.json");
          const installedManifest = JSON.parse(
            readFileSync(packageManifestPath, "utf8")
          );
          const installedRealpath = realpathSync(installedPath);
          const relative = path.relative(projectRoot, installedRealpath);
          if (relative.startsWith("..") || path.isAbsolute(relative))
            die(
              `${project.id}: internal package escapes sandbox ${rewrite.package}`
            );
          if (lstatSync(installedPath).isSymbolicLink())
            die(
              `${project.id}: internal package is a symlink ${rewrite.package}`
            );
          if (
            installedManifest.name !== rewrite.package ||
            installedManifest.version !== rewrite.expectedVersion ||
            lockEntry.version !== rewrite.expectedVersion ||
            lockEntry.integrity !== artifact.integrity ||
            !String(lockEntry.resolved).endsWith(artifact.filename) ||
            /^https?:/.test(String(lockEntry.resolved))
          )
            die(
              `${project.id}: internal origin differs for ${rewrite.package}`
            );
          for (const edgeId of rewrite.edgeIds)
            origins.push({
              status: "verified",
              edgeId,
              package: rewrite.package,
              expectedVersion: rewrite.expectedVersion,
              artifactId: rewrite.artifactId,
              lockResolved: lockEntry.resolved,
              lockIntegrity: lockEntry.integrity,
              installedPath,
              installedRealpath,
              manifestSha256: sha256File(packageManifestPath),
              insideSandbox: true,
              symlink: false,
            });
        }
        state.origins = origins.sort((left, right) =>
          left.edgeId.localeCompare(right.edgeId)
        );
        state.graphs = {
          externalBeforeSha256: project.externalGraph.sha256,
          externalAfterSha256: afterExternal.sha256,
          lockSha256: sha256File(state.lockPath),
          installedSha256: sha256(canonicalJson(installedGraph)),
          peerSha256: sha256(canonicalJson(installedGraph.problems ?? [])),
          moduleAuditSha256: sha256(canonicalJson(moduleAudit)),
          nodeModulesSha256: nodeModulesSha256(copied.destination),
        };
        if (project.browser) {
          verifyBrowserInstall(copied.destination, temporaryLock, {
            cacheRequired: false,
          });
          const argv = matrix.browser.setupArgv;
          state.currentCommand = argv;
          result = commandResult(argv, copied.destination);
          state.steps.push(
            stepRecord(
              "setup-browser",
              argv,
              result,
              path.join(projectOutput, "logs")
            )
          );
          if (result.status !== 0)
            die(`${project.id}: browser setup failed (${result.status})`);
          verifyBrowserInstall(copied.destination, temporaryLock, {
            cacheRequired: true,
          });
        }
        resetState = resetInputs(project, artifacts, state.graphs);
        writeFileSync(
          statePath,
          `${JSON.stringify(
            {
              resetInputs: resetState.value,
              resetInputsSha256: resetState.sha256,
              manifestSha256: sha256File(state.manifestPath),
              lockSha256: sha256File(state.lockPath),
              graphs: state.graphs,
              origins: state.origins,
              sentinel: state.sentinel,
              linkScan: state.linkScan,
            },
            null,
            2
          )}\n`
        );
      }

      if (reused) {
        const previous = JSON.parse(readFileSync(statePath, "utf8"));
        state.projectDirectory = path.join(projectRoot, "project");
        state.commandAdapter = installCommandAdapter(project, projectRoot);
        state.manifestPath = path.join(state.projectDirectory, "package.json");
        state.lockPath = path.join(state.projectDirectory, "package-lock.json");
        state.graphs = previous.graphs;
        state.origins = previous.origins;
        state.sentinel = sentinelProbe(state.projectDirectory);
        state.linkScan = previous.linkScan;
        if (
          sha256File(state.manifestPath) !== previous.manifestSha256 ||
          sha256File(state.lockPath) !== previous.lockSha256
        )
          die(`${project.id}: reusable staged manifest or lock is stale`);
        const reusedLock = JSON.parse(readFileSync(state.lockPath, "utf8"));
        const moduleAudit = sandboxModuleAudit(
          state.projectDirectory,
          reusedLock
        );
        if (project.browser)
          verifyBrowserInstall(state.projectDirectory, reusedLock, {
            cacheRequired: true,
          });
        if (
          sha256(canonicalJson(moduleAudit)) !==
            state.graphs.moduleAuditSha256 ||
          nodeModulesSha256(state.projectDirectory) !==
            state.graphs.nodeModulesSha256
        )
          die(`${project.id}: reusable installed module state is stale`);
        const lsArgv = ["npm", "ls", "--all", "--json"];
        state.currentCommand = lsArgv;
        const lsResult = commandResult(lsArgv, state.projectDirectory);
        state.steps.push(
          stepRecord(
            "reuse-npm-ls",
            lsArgv,
            lsResult,
            path.join(projectOutput, "logs")
          )
        );
        if (lsResult.status !== 0)
          die(`${project.id}: reusable npm ls failed (${lsResult.status})`);
        const installedGraph = JSON.parse(lsResult.stdout);
        if (
          sha256(canonicalJson(installedGraph)) !==
            state.graphs.installedSha256 ||
          sha256(canonicalJson(installedGraph.problems ?? [])) !==
            state.graphs.peerSha256
        )
          die(`${project.id}: reusable dependency or peer graph is stale`);
      }
      const selectedArgv = ["npm", "run", project.commands.selected];
      const selectedEnvironment = state.commandAdapter
        ? {
            ...environment,
            PATH: `${state.commandAdapter.shimDirectory}${path.delimiter}${environment.PATH}`,
            I02_COMMAND_ADAPTER_PATH: state.commandAdapter.shimDirectory,
          }
        : environment;
      state.currentCommand = selectedArgv;
      state.selectedEnvironment = selectedEnvironment;
      const selectedResult = commandResult(
        selectedArgv,
        state.projectDirectory,
        selectedEnvironment
      );
      state.steps.push(
        stepRecord(
          "selected",
          selectedArgv,
          selectedResult,
          path.join(projectOutput, "logs")
        )
      );
      if (selectedResult.status !== 0)
        die(
          `${project.id}: selected command failed (${selectedResult.status})`
        );

      if (project.browser && browserInstallSha256 === null)
        browserInstallSha256 = directorySha256(
          path.join(runRoot, "browser-cache")
        );
      const browserEvidence = project.browser
        ? {
            package: matrix.browser.installerPackage,
            version: matrix.browser.installerVersion,
            name: matrix.browser.name,
            revision: matrix.browser.revision,
            browserVersion: matrix.browser.version,
            descriptorSha256: matrix.browser.browsersJsonSha256,
            installRootSha256: browserInstallSha256,
          }
        : null;
      const runId = sha256(
        canonicalJson({ project: project.id, mode, reset: resetState.sha256 })
      ).slice(0, 24);
      state.runLock = {
        schemaVersion: 1,
        runId,
        fixtureId: project.id,
        mode,
        repository: repositoryState,
        contracts: {
          matrixSha256: sha256File(path.join(repository, matrixPath)),
          isolatedProjectsSha256: matrix.isolatedProjectsSha256,
          packageArtifactsSha256: matrix.packageArtifactsSha256,
          packageClassificationSha256: matrix.packageClassificationSha256,
          pathRepairsSha256: matrix.pathRepairsSha256,
          baselinesSha256: matrix.baselinesSha256,
          executionLockSha256: matrix.executionLockSha256,
        },
        platform: {
          os: process.platform,
          architecture: process.arch,
          imageDigest: matrix.runtime.imageDigest,
        },
        toolchain: {
          node: process.version.slice(1),
          npm: matrix.runtime.npm,
          npmConfigSha256: resetState.value.npmConfiguration,
        },
        browser: browserEvidence,
        environment: Object.fromEntries(
          Object.entries(selectedEnvironment).filter(([key]) =>
            [
              "CI",
              "HUSKY",
              "LC_ALL",
              "TZ",
              "PLAYWRIGHT_BROWSERS_PATH",
              "npm_config_cache",
              "npm_config_registry",
              "I02_COMMAND_ADAPTER_PATH",
            ].includes(key)
          )
        ),
        commands: {
          lock: matrix.lockPolicy.lockArgv,
          install: matrix.lockPolicy.installArgv,
          setupBrowser: project.browser ? matrix.browser.setupArgv : null,
          selected: selectedArgv,
          selectedSha256: commandSha256(selectedArgv),
        },
        sandbox: {
          path: projectRoot,
          realpath: realpathSync(projectRoot),
          cacheRoot,
          outsideRepositoryAncestry: true,
          linkScanSha256: state.linkScan.sha256,
          resetInputsSha256: resetState.sha256,
          reused,
        },
        sentinel: state.sentinel,
        original: {
          fixtureTreeSha256: project.fixtureTreeSha256,
          manifestPath: project.manifest,
          manifestSha256: project.committedManifestSha256,
          lockPath: project.committedLock.path,
          lockSha256: project.committedLock.sha256,
        },
        staged: {
          manifestPath: state.manifestPath,
          manifestSha256: sha256File(state.manifestPath),
          lockPath: state.lockPath,
          lockSha256: sha256File(state.lockPath),
          rewriteIds: project.rewriteIds,
        },
        artifacts: evidenceArtifacts.filter((artifact) =>
          project.rewrites.some(
            (rewrite) => rewrite.artifactId === artifact.artifactId
          )
        ),
        dependencyGraphs: state.graphs,
        origins: state.origins,
        steps: state.steps,
        result: { status: "pass", waiver: null, failureReason: null },
        failureBundle: null,
        replay: {
          replayArgv: [
            "node",
            "tools/run-integration-matrix.mjs",
            "--mode",
            mode,
            "--project",
            project.id,
            ...(cacheRoot ? ["--cache-root", cacheRoot] : []),
            "--retain",
          ],
          resetArgv: [
            "node",
            "tools/run-integration-matrix.mjs",
            "--mode",
            "reuse",
            "--project",
            project.id,
            "--cache-root",
            cacheRoot ?? "<external-cache-root>",
            "--reset",
          ],
          retainedSandbox: mode === "reuse" || retain ? projectRoot : null,
        },
      };
      await validateJsonSchema(
        state.runLock,
        path.join(repository, runLockSchemaPath)
      );
      writeFileSync(
        path.join(projectOutput, "run-lock.json"),
        `${JSON.stringify(state.runLock, null, 2)}\n`
      );
      gitFixtureGuard(project);
      results.push({
        fixtureId: project.id,
        status: "pass",
        runId,
        mode,
        reused,
        runLockSha256: sha256(canonicalJson(state.runLock)),
        runLock: path.relative(
          outputRoot,
          path.join(projectOutput, "run-lock.json")
        ),
      });
      if (mode === "clean" && !retain)
        rmSync(projectRoot, { recursive: true, force: true });
    } catch (error) {
      runFailed = true;
      const reason = error instanceof Error ? error : new Error(String(error));
      const unavailable = project.rewrites.flatMap((rewrite) =>
        rewrite.edgeIds.map((edgeId) =>
          incompleteOrigin(project, rewrite, edgeId, reason.message)
        )
      );
      if (!state.origins.length) state.origins = unavailable;
      const zero = sha256("");
      if (!state.graphs)
        state.graphs = {
          externalBeforeSha256: project.externalGraph.sha256,
          externalAfterSha256: zero,
          lockSha256:
            state.lockPath && existsSync(state.lockPath)
              ? sha256File(state.lockPath)
              : zero,
          installedSha256: zero,
          peerSha256: zero,
          moduleAuditSha256: zero,
          nodeModulesSha256: zero,
        };
      if (!state.sentinel)
        state.sentinel = {
          package: matrix.sandboxPolicy.sentinelPackage,
          checkoutPath: sentinelPath,
          preexisting: false,
          resolved: false,
          status: "not-probed",
        };
      state.linkScan ??= { sha256: zero, status: "not-completed" };
      const failureStatePath = path.join(projectOutput, "failure-state.json");
      const failureBrowser =
        project.browser &&
        existsSync(
          path.join(
            runRoot,
            "browser-cache",
            `${matrix.browser.name}-${matrix.browser.revision}`
          )
        )
          ? {
              package: matrix.browser.installerPackage,
              version: matrix.browser.installerVersion,
              name: matrix.browser.name,
              revision: matrix.browser.revision,
              browserVersion: matrix.browser.version,
              descriptorSha256: matrix.browser.browsersJsonSha256,
              installRootSha256: directorySha256(
                path.join(runRoot, "browser-cache")
              ),
            }
          : null;
      state.runLock = {
        schemaVersion: 1,
        runId: sha256(
          canonicalJson({ project: project.id, mode, failure: reason.message })
        ).slice(0, 24),
        fixtureId: project.id,
        mode,
        repository: repositoryState,
        contracts: {
          matrixSha256: sha256File(path.join(repository, matrixPath)),
          isolatedProjectsSha256: matrix.isolatedProjectsSha256,
          packageArtifactsSha256: matrix.packageArtifactsSha256,
          packageClassificationSha256: matrix.packageClassificationSha256,
          pathRepairsSha256: matrix.pathRepairsSha256,
          baselinesSha256: matrix.baselinesSha256,
          executionLockSha256: matrix.executionLockSha256,
        },
        platform: {
          os: process.platform,
          architecture: process.arch,
          imageDigest: matrix.runtime.imageDigest,
        },
        toolchain: {
          node: process.version.slice(1),
          npm: matrix.runtime.npm,
          npmConfigSha256: resetState.value.npmConfiguration,
        },
        browser: failureBrowser,
        environment: Object.fromEntries(
          Object.entries(state.selectedEnvironment ?? environment).filter(
            ([key]) =>
              [
                "CI",
                "HUSKY",
                "LC_ALL",
                "TZ",
                "PLAYWRIGHT_BROWSERS_PATH",
                "npm_config_cache",
                "npm_config_registry",
                "I02_COMMAND_ADAPTER_PATH",
              ].includes(key)
          )
        ),
        commands: {
          lock: matrix.lockPolicy.lockArgv,
          install: matrix.lockPolicy.installArgv,
          setupBrowser: project.browser ? matrix.browser.setupArgv : null,
          selected: ["npm", "run", project.commands.selected],
          selectedSha256: commandSha256([
            "npm",
            "run",
            project.commands.selected,
          ]),
        },
        sandbox: {
          path: projectRoot,
          realpath: existsSync(projectRoot)
            ? realpathSync(projectRoot)
            : projectRoot,
          cacheRoot,
          outsideRepositoryAncestry: true,
          linkScanSha256: state.linkScan.sha256,
          resetInputsSha256: resetState.sha256,
          reused,
        },
        sentinel: state.sentinel,
        original: {
          fixtureTreeSha256: project.fixtureTreeSha256,
          manifestPath: project.manifest,
          manifestSha256: project.committedManifestSha256,
          lockPath: project.committedLock.path,
          lockSha256: project.committedLock.sha256,
        },
        staged: {
          manifestPath: state.manifestPath ?? "not-produced",
          manifestSha256:
            state.manifestPath && existsSync(state.manifestPath)
              ? sha256File(state.manifestPath)
              : zero,
          lockPath: state.lockPath ?? "not-produced",
          lockSha256:
            state.lockPath && existsSync(state.lockPath)
              ? sha256File(state.lockPath)
              : zero,
          rewriteIds: project.rewriteIds,
        },
        artifacts: evidenceArtifacts.filter((artifact) =>
          project.rewrites.some(
            (rewrite) => rewrite.artifactId === artifact.artifactId
          )
        ),
        dependencyGraphs: state.graphs,
        origins: state.origins,
        steps: state.steps.length
          ? state.steps
          : [
              {
                id: "precondition",
                argv: state.currentCommand ?? [
                  "node",
                  "tools/run-integration-matrix.mjs",
                ],
                status: -1,
                stdoutSha256: zero,
                stderrSha256: sha256(reason.message),
              },
            ],
        result: {
          status: "failure",
          waiver: null,
          failureReason: reason.message,
        },
        failureBundle: null,
        replay: {
          replayArgv: [
            "node",
            "tools/run-integration-matrix.mjs",
            "--mode",
            mode,
            "--project",
            project.id,
            ...(cacheRoot ? ["--cache-root", cacheRoot] : []),
            "--retain",
          ],
          resetArgv: [
            "node",
            "tools/run-integration-matrix.mjs",
            "--mode",
            "reuse",
            "--project",
            project.id,
            "--cache-root",
            cacheRoot ?? "<external-cache-root>",
            "--reset",
          ],
          retainedSandbox: projectRoot,
        },
      };
      writeFileSync(
        failureStatePath,
        `${JSON.stringify(state.runLock, null, 2)}\n`
      );
      await validateJsonSchema(
        state.runLock,
        path.join(repository, runLockSchemaPath)
      );
      const bundle = writeFailureBundle(
        project,
        projectOutput,
        projectRoot,
        state,
        reason
      );
      state.runLock.failureBundle = bundle;
      await validateJsonSchema(
        state.runLock,
        path.join(repository, runLockSchemaPath)
      );
      const failureRunLock = path.join(projectOutput, "run-lock.json");
      writeFileSync(
        failureRunLock,
        `${JSON.stringify(state.runLock, null, 2)}\n`
      );
      writeFileSync(
        failureStatePath,
        `${JSON.stringify(state.runLock, null, 2)}\n`
      );
      results.push({
        fixtureId: project.id,
        status: "failure",
        mode,
        reason: reason.message,
        failureBundle: bundle.path,
        retainedSandbox: projectRoot,
        runLock: path.relative(outputRoot, failureRunLock),
      });
      break;
    }
  }
} finally {
  removeSentinel();
}

const summary = {
  schemaVersion: 1,
  task: "I02",
  owner: matrix.owner,
  matrixSha256: sha256File(path.join(repository, matrixPath)),
  repository: repositoryState,
  runtime: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version.slice(1),
    npm: matrix.runtime.npm,
    imageDigest: matrix.runtime.imageDigest,
    environment: matrix.runtime.environment,
    forbiddenEnvironmentAbsent: matrix.runtime.forbiddenEnvironment.filter(
      (key) => !Object.hasOwn(environment, key)
    ),
  },
  artifacts: evidenceArtifacts,
  mode,
  selected: selected.map((project) => project.id),
  counts: {
    selected: selected.length,
    passed: results.filter((result) => result.status === "pass").length,
    failed: results.filter((result) => result.status === "failure").length,
    logicalEdges: selected.reduce(
      (count, project) => count + project.edgeIds.length,
      0
    ),
    browserProjects: selected.filter((project) => project.browser).length,
  },
  coverage: {
    matrixProjects: matrix.counts.projects,
    runnableProjects: matrix.counts.runnable,
    templateProjects: matrix.counts.templates,
    matrixLogicalEdges: matrix.counts.logicalEdges,
    runnableLogicalEdges: runnable.reduce(
      (count, project) => count + project.edgeIds.length,
      0
    ),
    templateLogicalEdges: matrix.projects
      .filter((project) => project.mode === "template")
      .reduce((count, project) => count + project.edgeIds.length, 0),
    browserProjects: matrix.counts.browserProjects,
  },
  results,
};
writeFileSync(
  path.join(outputRoot, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`
);
if (writeEvidence) {
  const evidenceDirectory = path.join(repository, "migration/evidence/i02");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    path.join(evidenceDirectory, "integration-proof.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
}
if (mode === "clean" && !retain && !runFailed)
  rmSync(runRoot, { recursive: true, force: true });
if (runFailed) {
  console.error(`INTEGRATION_MATRIX_RUN_FAILED output=${outputRoot}`);
  process.exit(1);
}
console.log(
  `INTEGRATION_MATRIX_RUN_OK mode=${mode} projects=${summary.counts.passed} edges=${summary.counts.logicalEdges} browser=${summary.counts.browserProjects} output=${outputRoot}`
);
