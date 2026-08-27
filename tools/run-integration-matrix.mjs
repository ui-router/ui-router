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
const allowedRepositoryOutputRoot = path.join(
  repository,
  ".migration-work/i02"
);
function lexicallyInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
function rejectSymlinkComponents(candidate) {
  let current = path.parse(candidate).root;
  for (const component of path.relative(current, candidate).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      die(`path component is a symbolic link: ${current}`);
  }
}
if (
  lexicallyInside(outputRoot, repository) ||
  (lexicallyInside(repository, outputRoot) &&
    !lexicallyInside(allowedRepositoryOutputRoot, outputRoot))
)
  die(`unsafe output path: ${outputRoot}`);
rejectSymlinkComponents(outputRoot);
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });
const cacheRoot = cacheArgument ? path.resolve(cacheArgument) : null;
if (cacheRoot) {
  rejectSymlinkComponents(cacheRoot);
  mkdirSync(cacheRoot, { recursive: true });
  if (lstatSync(cacheRoot).isSymbolicLink())
    die("cache root must not be a symbolic link");
  assertExternalSandbox(repository, cacheRoot);
}
const cleanRoot =
  mode === "clean"
    ? mkdtempSync(path.join(realpathSync(os.tmpdir()), "uirouter-i02-clean-"))
    : null;
const runRoot = mode === "clean" ? cleanRoot : realpathSync(cacheRoot);
assertExternalSandbox(repository, runRoot);
function ensureOwnedDirectory(name) {
  const target = path.join(runRoot, name);
  rejectSymlinkComponents(target);
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isDirectory())
      die(`cache-owned path is not a physical directory: ${target}`);
  } else mkdirSync(target);
  const realTarget = realpathSync(target);
  if (!lexicallyInside(runRoot, realTarget))
    die(`cache-owned directory escapes the run root: ${target}`);
  return realTarget;
}
const artifactStagingRoot = ensureOwnedDirectory("artifacts");
ensureOwnedDirectory("npm-cache");
ensureOwnedDirectory("browser-cache");
ensureOwnedDirectory("projects");

const inheritedNpmConfig = Object.keys(process.env).filter((key) =>
  key.toLowerCase().startsWith("npm_config_")
);
const discardedInheritedNpmConfig = new Set([
  "npm_config_cache",
  "npm_config_prefix",
  "npm_config_registry",
]);
const unexpectedNpmConfig = inheritedNpmConfig.filter(
  (key) => !discardedInheritedNpmConfig.has(key.toLowerCase())
);
if (unexpectedNpmConfig.length)
  die(
    `unapproved inherited npm configuration: ${unexpectedNpmConfig
      .sort()
      .join(",")}`
  );
if (
  inheritedNpmConfig.some(
    (key) =>
      key.toLowerCase() === "npm_config_registry" &&
      process.env[key] !== matrix.networkPolicy.registry
  )
)
  die("inherited npm registry differs from the matrix");
const npmWhich = spawnSync("which", ["npm"], { encoding: "utf8" });
if (npmWhich.status !== 0) die("cannot resolve the npm executable");
const npmExecutable = realpathSync(npmWhich.stdout.trim());
const nodeExecutable = realpathSync(process.execPath);
const generatedNpmrc = path.join(runRoot, "npmrc");
const generatedNpmrcContents = [
  `registry=${matrix.networkPolicy.registry}`,
  `cache=${path.join(runRoot, "npm-cache")}`,
  "ignore-scripts=true",
  "audit=false",
  "fund=false",
  "legacy-peer-deps=false",
  "force=false",
  "offline=false",
  "bin-links=true",
  "",
].join("\n");
rejectSymlinkComponents(generatedNpmrc);
if (existsSync(generatedNpmrc) && lstatSync(generatedNpmrc).isSymbolicLink())
  die("generated npmrc path must not be a symbolic link");
writeFileSync(generatedNpmrc, generatedNpmrcContents);
ensureOwnedDirectory("home");
ensureOwnedDirectory("tmp");
const environment = {
  PATH: [
    path.dirname(nodeExecutable),
    path.dirname(npmExecutable),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(path.delimiter),
  HOME: path.join(runRoot, "home"),
  TMPDIR: path.join(runRoot, "tmp"),
  ...matrix.runtime.environment,
  npm_config_cache: path.join(runRoot, "npm-cache"),
  npm_config_registry: matrix.networkPolicy.registry,
  npm_config_userconfig: generatedNpmrc,
  npm_config_globalconfig: "/dev/null",
  npm_config_ignore_scripts: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_legacy_peer_deps: "false",
  npm_config_force: "false",
  npm_config_offline: "false",
  npm_config_bin_links: "true",
  PLAYWRIGHT_BROWSERS_PATH: path.join(runRoot, "browser-cache"),
};
for (const key of matrix.runtime.forbiddenEnvironment)
  if (Object.hasOwn(environment, key)) die(`forbidden environment key ${key}`);

const commandResult = (argv, cwd, env = environment) => {
  const executable = argv[0] === "npm" ? npmExecutable : argv[0];
  const result = spawnSync(executable, argv.slice(1), {
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
  for (const entry of readdirSync(artifactStagingRoot)) {
    const target = path.join(artifactStagingRoot, entry);
    if (lstatSync(target).isSymbolicLink())
      die(`artifact staging contains a symbolic link: ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
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

function projectArtifactIds(project) {
  return [
    ...new Set([
      ...project.rewrites.map((rewrite) => rewrite.artifactId),
      ...project.closureBindings.map((binding) => binding.artifactId),
    ]),
  ].sort();
}

function stageManifest(
  project,
  projectDirectory,
  artifactMap,
  allowPreviouslyStaged = false
) {
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
    const previouslyStaged =
      allowPreviouslyStaged && String(before ?? "").startsWith("file:");
    if (
      rewrite.operation === "replace-declared" &&
      before !== rewrite.declaredSpec &&
      !previouslyStaged
    )
      die(`${project.id}: declaration changed before staging ${rewrite.id}`);
    if (
      rewrite.operation === "inject-legacy" &&
      before !== undefined &&
      !previouslyStaged
    )
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
      id: rewrite.id,
      kind: "logical-edge",
      section: rewrite.manifestSection,
      package: rewrite.package,
      before: before ?? null,
      after: `file:${relative}`,
    });
  }
  for (const binding of project.closureBindings) {
    const artifact = artifactMap.get(binding.artifactId);
    if (!artifact || artifact.package !== binding.package)
      die(`${project.id}: closure artifact mismatch for ${binding.id}`);
    manifest[binding.manifestSection] ??= {};
    const before = manifest[binding.manifestSection][binding.package];
    if (
      before !== undefined &&
      !(allowPreviouslyStaged && String(before).startsWith("file:"))
    )
      die(
        `${project.id}: closure package is already declared ${binding.package}`
      );
    const relative = path
      .relative(projectDirectory, artifact.path)
      .split(path.sep)
      .join("/");
    manifest[binding.manifestSection][binding.package] = `file:${relative}`;
    changed.push({
      id: binding.id,
      kind: "p01-internal-closure",
      section: binding.manifestSection,
      package: binding.package,
      before: null,
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

function internalPackageName(lockPath) {
  const marker = "/node_modules/";
  const normalized = lockPath.replaceAll("\\", "/");
  const index = normalized.lastIndexOf(marker);
  const suffix =
    index === -1
      ? normalized.replace(/^node_modules\//, "")
      : normalized.slice(index + marker.length);
  if (!suffix || suffix.includes("node_modules/")) return null;
  const parts = suffix.split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function auditInternalPackages(
  project,
  projectDirectory,
  temporaryLock,
  artifactMap
) {
  const records = [];
  for (const [lockPath, lockEntry] of Object.entries(temporaryLock.packages)) {
    if (!lockPath.includes("node_modules/")) continue;
    const packageName = internalPackageName(lockPath);
    const artifact = [...artifactMap.values()].find(
      (candidate) => candidate.package === packageName
    );
    if (!artifact) continue;
    if (!projectArtifactIds(project).includes(artifact.artifactId))
      die(
        `${project.id}: undeclared internal package entered the staged graph: ${packageName}`
      );
    const installedPath = path.join(projectDirectory, ...lockPath.split("/"));
    const expectedResolved = `file:${path
      .relative(projectDirectory, artifact.path)
      .split(path.sep)
      .join("/")}`;
    const artifactRealpath = realpathSync(artifact.path);
    if (
      lstatSync(artifact.path).isSymbolicLink() ||
      !lexicallyInside(artifactStagingRoot, artifactRealpath) ||
      sha256File(artifact.path) !== artifact.sha256
    )
      die(
        `${project.id}: staged artifact provenance differs: ${artifact.artifactId}`
      );
    if (!existsSync(installedPath))
      die(`${project.id}: internal lock entry is not installed: ${lockPath}`);
    const installedRealpath = realpathSync(installedPath);
    const relative = path.relative(projectDirectory, installedRealpath);
    const packageManifestPath = path.join(installedPath, "package.json");
    const installedManifest = JSON.parse(
      readFileSync(packageManifestPath, "utf8")
    );
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      lstatSync(installedPath).isSymbolicLink() ||
      installedManifest.name !== packageName ||
      installedManifest.version !== artifact.version ||
      lockEntry.version !== artifact.version ||
      lockEntry.integrity !== artifact.integrity ||
      lockEntry.resolved !== expectedResolved
    )
      die(`${project.id}: internal package provenance differs: ${lockPath}`);
    records.push({
      lockPath,
      package: packageName,
      expectedVersion: artifact.version,
      artifactId: artifact.artifactId,
      lockResolved: lockEntry.resolved,
      expectedLockResolved: expectedResolved,
      lockIntegrity: lockEntry.integrity,
      stagedArtifactPath: artifact.path,
      stagedArtifactRealpath: artifactRealpath,
      installedPath,
      installedRealpath,
      manifestSha256: sha256File(packageManifestPath),
      insideSandbox: true,
      symlink: false,
    });
  }
  const expectedIds = projectArtifactIds(project);
  const topLevelIds = records
    .filter((record) => record.lockPath === `node_modules/${record.package}`)
    .map((record) => record.artifactId)
    .sort();
  if (canonicalJson(topLevelIds) !== canonicalJson(expectedIds))
    die(`${project.id}: complete top-level internal artifact closure differs`);
  return records.sort((left, right) =>
    left.lockPath.localeCompare(right.lockPath)
  );
}

function auditLogicalOrigins(
  project,
  projectRoot,
  projectDirectory,
  temporaryLock,
  artifactMap
) {
  const origins = [];
  for (const rewrite of project.rewrites) {
    const artifact = artifactMap.get(rewrite.artifactId);
    const key = `node_modules/${rewrite.package}`;
    const lockEntry = temporaryLock.packages[key];
    const installedPath = path.join(projectDirectory, ...key.split("/"));
    const expectedResolved = `file:${path
      .relative(projectDirectory, artifact.path)
      .split(path.sep)
      .join("/")}`;
    if (!lockEntry || !existsSync(installedPath))
      die(`${project.id}: internal package is missing ${rewrite.package}`);
    const packageManifestPath = path.join(installedPath, "package.json");
    const installedManifest = JSON.parse(
      readFileSync(packageManifestPath, "utf8")
    );
    const installedRealpath = realpathSync(installedPath);
    const relative = path.relative(projectRoot, installedRealpath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      lstatSync(installedPath).isSymbolicLink() ||
      installedManifest.name !== rewrite.package ||
      installedManifest.version !== rewrite.expectedVersion ||
      lockEntry.version !== rewrite.expectedVersion ||
      lockEntry.integrity !== artifact.integrity ||
      lockEntry.resolved !== expectedResolved
    )
      die(`${project.id}: internal origin differs for ${rewrite.package}`);
    for (const edgeId of rewrite.edgeIds)
      origins.push({
        status: "verified",
        edgeId,
        package: rewrite.package,
        expectedVersion: rewrite.expectedVersion,
        artifactId: rewrite.artifactId,
        lockResolved: lockEntry.resolved,
        expectedLockResolved: expectedResolved,
        lockIntegrity: lockEntry.integrity,
        stagedArtifactPath: artifact.path,
        stagedArtifactRealpath: realpathSync(artifact.path),
        installedPath,
        installedRealpath,
        manifestSha256: sha256File(packageManifestPath),
        insideSandbox: true,
        symlink: false,
      });
  }
  return origins.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
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

function executableFileHashes(root) {
  const records = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        die(`browser cache contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && statSync(absolute).mode & 0o111)
        records.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          sha256: sha256File(absolute),
        });
    }
  }
  walk(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function verifyBrowserInstall(
  projectDirectory,
  temporaryLock,
  { cacheRequired }
) {
  const installer = temporaryLock.packages["node_modules/@playwright/test"];
  const launcher = temporaryLock.packages["node_modules/playwright"];
  const core = temporaryLock.packages["node_modules/playwright-core"];
  const descriptor = path.join(
    projectDirectory,
    "node_modules/playwright-core/browsers.json"
  );
  if (
    !installer ||
    installer.version !== matrix.browser.installerVersion ||
    installer.integrity !== matrix.browser.installerIntegrity ||
    !launcher ||
    launcher.version !== matrix.browser.launcherVersion ||
    launcher.integrity !== matrix.browser.launcherIntegrity ||
    !core ||
    core.version !== matrix.browser.installerVersion ||
    core.integrity !== matrix.browser.coreIntegrity ||
    !existsSync(descriptor) ||
    sha256File(descriptor) !== matrix.browser.browsersJsonSha256
  )
    die("installed Playwright package provenance differs from the matrix");
  const evidence = {
    installerDirectorySha256: directorySha256(
      path.join(projectDirectory, "node_modules/@playwright/test")
    ),
    launcherDirectorySha256: directorySha256(
      path.join(projectDirectory, "node_modules/playwright")
    ),
    coreDirectorySha256: directorySha256(
      path.join(projectDirectory, "node_modules/playwright-core")
    ),
    executableFiles: [],
    portableCacheSha256: null,
  };
  if (cacheRequired) {
    const browserRoot = path.join(runRoot, "browser-cache");
    const names = readdirSync(browserRoot);
    for (const expected of [
      `${matrix.browser.name}-${matrix.browser.revision}`,
      `${matrix.browser.name}_headless_shell-${matrix.browser.revision}`,
    ])
      if (!names.includes(expected))
        die(`browser cache is missing ${expected}`);
    evidence.executableFiles = executableFileHashes(browserRoot);
    evidence.portableCacheSha256 = directorySha256(
      browserRoot,
      new Set([".links"])
    );
    if (
      evidence.installerDirectorySha256 !==
        matrix.browser.expectedInstallerDirectorySha256 ||
      evidence.launcherDirectorySha256 !==
        matrix.browser.expectedLauncherDirectorySha256 ||
      evidence.coreDirectorySha256 !==
        matrix.browser.expectedCoreDirectorySha256 ||
      canonicalJson(evidence.executableFiles) !==
        canonicalJson(matrix.browser.expectedExecutableFiles) ||
      evidence.portableCacheSha256 !==
        matrix.browser.expectedPortableCacheSha256
    )
      die("installed Playwright/browser content differs from pinned hashes");
  }
  return evidence;
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
function effectiveNpmSettings(project) {
  return {
    registry: matrix.networkPolicy.registry,
    cache: environment.npm_config_cache,
    "ignore-scripts": "true",
    audit: "false",
    fund: "false",
    "legacy-peer-deps": "false",
    force: "false",
    offline: "false",
    "bin-links": "true",
    ...(project.projectNpmrc?.allowedSettings ?? {}),
  };
}
function npmConfigSha256(project) {
  return sha256(
    canonicalJson({
      repositoryNpmrcSha256: sha256File(path.join(repository, ".npmrc")),
      generatedNpmrcSha256: sha256(generatedNpmrcContents),
      registry: matrix.networkPolicy.registry,
      cache: environment.npm_config_cache,
      nodeExecutable,
      nodeExecutableSha256: sha256File(nodeExecutable),
      npmExecutable,
      npmExecutableSha256: sha256File(npmExecutable),
      effectiveEnvironment: environment,
      projectNpmrc: project.projectNpmrc,
      effectiveNpmSettings: effectiveNpmSettings(project),
      lockArgv: matrix.lockPolicy.lockArgv,
      installArgv: matrix.lockPolicy.installArgv,
      reuseInstallArgv: matrix.lockPolicy.reuseInstallArgv,
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
    npmConfiguration: npmConfigSha256(project),
    browser: project.browser ? matrix.browser : null,
    tarballs: artifacts
      .filter((artifact) =>
        projectArtifactIds(project).includes(artifact.artifactId)
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
  const addBytes = (
    name,
    relative,
    bytes,
    status = "produced",
    reason = null
  ) => {
    const target = path.join(bundle, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    files.set(name, { relative, status, reason });
  };
  const addSource = (name, relative, source) => {
    if (source && existsSync(source))
      addBytes(name, relative, readFileSync(source));
    else {
      const reason = source ? "source-path-not-produced" : "phase-not-reached";
      addBytes(
        name,
        relative,
        Buffer.from(
          `${JSON.stringify({ status: "unavailable", reason }, null, 2)}\n`
        ),
        "unavailable",
        reason
      );
    }
  };
  const addJsonState = (name, relative, value, reason) => {
    if (value === null || value === undefined || value.status) {
      const unavailableReason = reason ?? value?.status ?? "phase-not-reached";
      addBytes(
        name,
        relative,
        Buffer.from(
          `${JSON.stringify(
            { status: "unavailable", reason: unavailableReason },
            null,
            2
          )}\n`
        ),
        "unavailable",
        unavailableReason
      );
    } else
      addBytes(
        name,
        relative,
        Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
      );
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
  const detachedRunLock = {
    ...state.runLock,
    bundleState: "detached-pre-manifest",
    failureBundle: null,
  };
  addBytes(
    "run-lock",
    "run-lock.json",
    Buffer.from(`${JSON.stringify(detachedRunLock, null, 2)}\n`)
  );
  const archiveDirectory = path.join(bundle, "artifacts");
  mkdirSync(archiveDirectory, { recursive: true });
  for (const artifact of state.artifacts ?? [])
    cpSync(artifact.path, path.join(archiveDirectory, artifact.filename));
  files.set("artifact-archives", {
    relative: "artifacts",
    status: "produced",
    reason: null,
  });
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
          environment: state.selectedEnvironment ?? environment,
        },
        null,
        2
      )}\n`
    )
  );
  addJsonState(
    "dependency-graph",
    "dependency-graph.json",
    state.graphs,
    "dependency-graph-not-produced"
  );
  addBytes(
    "origin-audit",
    "origin-audit.json",
    Buffer.from(`${JSON.stringify(state.origins ?? [], null, 2)}\n`)
  );
  addJsonState(
    "ancestry-link-scan",
    "ancestry-link-scan.json",
    state.linkScan,
    "ancestry-link-scan-not-produced"
  );
  addJsonState(
    "sentinel-probe",
    "sentinel-probe.json",
    state.sentinel,
    "sentinel-probe-not-produced"
  );
  addJsonState(
    "exact-command",
    "command.json",
    state.currentCommand,
    "command-not-started"
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
    const record = files.get(name);
    if (!record) die(`failure bundle did not create ${name}`);
    const absolute = path.join(bundle, record.relative);
    const digest = statSync(absolute).isDirectory()
      ? directorySha256(absolute)
      : sha256File(absolute);
    return {
      name,
      path: record.relative,
      sha256: digest,
      status: record.status,
      reason: record.reason,
    };
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
    const state = {
      artifacts,
      steps: [],
      origins: [],
      internalPackages: [],
      browserProvenance: null,
      currentPhase: null,
      currentStderr: "",
      graphs: null,
    };
    const statePath = path.join(projectRoot, "state.json");
    let previous = null;
    let reusablePreconditionError = null;
    try {
      if (existsSync(projectRoot)) {
        if (lstatSync(projectRoot).isSymbolicLink())
          die(`${project.id}: reusable project root is a symbolic link`);
        assertExternalSandbox(repository, projectRoot);
        const reusableProjectDirectory = path.join(projectRoot, "project");
        if (existsSync(reusableProjectDirectory)) {
          if (lstatSync(reusableProjectDirectory).isSymbolicLink())
            die(`${project.id}: reusable fixture root is a symbolic link`);
          assertExternalSandbox(repository, reusableProjectDirectory);
        }
        if (existsSync(statePath)) {
          if (lstatSync(statePath).isSymbolicLink())
            die(`${project.id}: reusable state is a symbolic link`);
          previous = JSON.parse(readFileSync(statePath, "utf8"));
        }
      }
    } catch (error) {
      reusablePreconditionError = error;
    }
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
    let reuseUpdated = false;
    let changedArtifactIds = [];
    try {
      if (reusablePreconditionError) throw reusablePreconditionError;
      if (mode === "reuse" && previous && !resetRequested) {
        if (previous.resetInputsSha256 !== resetState.sha256) {
          const changedKeys = Object.keys(resetState.value).filter(
            (key) =>
              canonicalJson(resetState.value[key]) !==
              canonicalJson(previous.resetInputs[key])
          );
          const sortedChangedKeys = [...changedKeys].sort();
          const allowedArtifactUpdate = [
            ["tarballs"],
            ["repositoryRevision", "tarballs"],
          ].some(
            (allowed) =>
              canonicalJson(sortedChangedKeys) === canonicalJson(allowed)
          );
          if (!allowedArtifactUpdate)
            die(
              `${project.id}: reusable state is stale (${sortedChangedKeys.join(
                ","
              )}); rerun with --reset`
            );
          const priorTarballs = new Map(
            previous.resetInputs.tarballs.map((record) => [
              record.artifactId,
              record.sha256,
            ])
          );
          changedArtifactIds = resetState.value.tarballs
            .filter(
              (record) => priorTarballs.get(record.artifactId) !== record.sha256
            )
            .map((record) => record.artifactId)
            .sort();
          if (!changedArtifactIds.length)
            die(
              `${project.id}: reusable reset digest changed without changed artifacts`
            );
          reuseUpdated = true;
        }
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
        state.currentPhase = "lock";
        state.currentCommand = matrix.lockPolicy.lockArgv;
        let result = commandResult(
          matrix.lockPolicy.lockArgv,
          copied.destination
        );
        state.currentStderr = result.stderr;
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
        state.internalPackages = auditInternalPackages(
          project,
          copied.destination,
          temporaryLock,
          artifactMap
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
        state.origins = auditLogicalOrigins(
          project,
          projectRoot,
          copied.destination,
          temporaryLock,
          artifactMap
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
          state.browserProvenance = verifyBrowserInstall(
            copied.destination,
            temporaryLock,
            { cacheRequired: true }
          );
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
              internalPackages: state.internalPackages,
              browserProvenance: state.browserProvenance,
              sentinel: state.sentinel,
              linkScan: state.linkScan,
            },
            null,
            2
          )}\n`
        );
      }

      if (reused) {
        state.projectDirectory = path.join(projectRoot, "project");
        assertExternalSandbox(repository, state.projectDirectory);
        const freshLinkScanSha256 = assertNoLinksOrSharedFiles(
          path.join(repository, path.dirname(project.manifest)),
          state.projectDirectory
        );
        if (freshLinkScanSha256 !== previous.linkScan.sha256)
          die(`${project.id}: reusable fixture topology is stale`);
        state.commandAdapter = installCommandAdapter(project, projectRoot);
        state.manifestPath = path.join(state.projectDirectory, "package.json");
        state.lockPath = path.join(state.projectDirectory, "package-lock.json");
        state.graphs = previous.graphs;
        state.origins = previous.origins;
        state.internalPackages = previous.internalPackages;
        state.browserProvenance = previous.browserProvenance;
        state.sentinel = sentinelProbe(state.projectDirectory);
        state.linkScan = {
          ...previous.linkScan,
          sha256: freshLinkScanSha256,
        };
        if (
          sha256File(state.manifestPath) !== previous.manifestSha256 ||
          sha256File(state.lockPath) !== previous.lockSha256
        )
          die(`${project.id}: reusable staged manifest or lock is stale`);
        if (reuseUpdated) {
          stageManifest(project, state.projectDirectory, artifactMap, true);
          state.currentCommand = matrix.lockPolicy.lockArgv;
          let updateResult = commandResult(
            matrix.lockPolicy.lockArgv,
            state.projectDirectory
          );
          state.steps.push(
            stepRecord(
              "reuse-lock",
              matrix.lockPolicy.lockArgv,
              updateResult,
              path.join(projectOutput, "logs")
            )
          );
          if (updateResult.status !== 0)
            die(
              `${project.id}: reusable lock update failed (${updateResult.status})`
            );
          const updatedLock = JSON.parse(readFileSync(state.lockPath, "utf8"));
          const updatedExternal = installedExternalGraph(
            updatedLock,
            publishedNames
          );
          if (updatedExternal.sha256 !== project.expectedExternalGraphSha256)
            die(`${project.id}: reusable external graph update differs`);
          const updateArgv = [
            ...matrix.lockPolicy.reuseInstallArgv,
            ...changedArtifactIds.map(
              (artifactId) => artifactMap.get(artifactId).path
            ),
          ];
          state.currentCommand = updateArgv;
          updateResult = commandResult(updateArgv, state.projectDirectory);
          state.steps.push(
            stepRecord(
              "reuse-install",
              updateArgv,
              updateResult,
              path.join(projectOutput, "logs")
            )
          );
          if (updateResult.status !== 0)
            die(
              `${project.id}: reusable artifact install failed (${updateResult.status})`
            );
          const updatedLockSha256 = sha256File(state.lockPath);
          const updatedInternalPackages = auditInternalPackages(
            project,
            state.projectDirectory,
            updatedLock,
            artifactMap
          );
          const updatedModuleAudit = sandboxModuleAudit(
            state.projectDirectory,
            updatedLock
          );
          const updateLsArgv = ["npm", "ls", "--all", "--json"];
          state.currentCommand = updateLsArgv;
          const updateLsResult = commandResult(
            updateLsArgv,
            state.projectDirectory
          );
          state.steps.push(
            stepRecord(
              "reuse-update-npm-ls",
              updateLsArgv,
              updateLsResult,
              path.join(projectOutput, "logs")
            )
          );
          if (updateLsResult.status !== 0)
            die(
              `${project.id}: reusable updated npm ls failed (${updateLsResult.status})`
            );
          const updatedInstalledGraph = JSON.parse(updateLsResult.stdout);
          state.origins = auditLogicalOrigins(
            project,
            projectRoot,
            state.projectDirectory,
            updatedLock,
            artifactMap
          );
          state.internalPackages = updatedInternalPackages;
          state.graphs = {
            externalBeforeSha256: project.externalGraph.sha256,
            externalAfterSha256: updatedExternal.sha256,
            lockSha256: updatedLockSha256,
            installedSha256: sha256(canonicalJson(updatedInstalledGraph)),
            peerSha256: sha256(
              canonicalJson(updatedInstalledGraph.problems ?? [])
            ),
            moduleAuditSha256: sha256(canonicalJson(updatedModuleAudit)),
            nodeModulesSha256: nodeModulesSha256(state.projectDirectory),
          };
          if (project.browser)
            state.browserProvenance = verifyBrowserInstall(
              state.projectDirectory,
              updatedLock,
              { cacheRequired: true }
            );
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
                internalPackages: state.internalPackages,
                browserProvenance: state.browserProvenance,
                sentinel: state.sentinel,
                linkScan: state.linkScan,
              },
              null,
              2
            )}\n`
          );
        }
        const reusedLock = JSON.parse(readFileSync(state.lockPath, "utf8"));
        const moduleAudit = sandboxModuleAudit(
          state.projectDirectory,
          reusedLock
        );
        const reusedInternalPackages = auditInternalPackages(
          project,
          state.projectDirectory,
          reusedLock,
          artifactMap
        );
        if (
          canonicalJson(reusedInternalPackages) !==
          canonicalJson(state.internalPackages)
        )
          die(`${project.id}: reusable internal package provenance is stale`);
        if (project.browser) {
          const reusedBrowserProvenance = verifyBrowserInstall(
            state.projectDirectory,
            reusedLock,
            { cacheRequired: true }
          );
          if (
            canonicalJson(reusedBrowserProvenance) !==
            canonicalJson(state.browserProvenance ?? previous.browserProvenance)
          )
            die(`${project.id}: reusable browser provenance is stale`);
          state.browserProvenance = reusedBrowserProvenance;
        }
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
          path.join(runRoot, "browser-cache"),
          new Set([".links"])
        );
      const browserEvidence = project.browser
        ? {
            package: matrix.browser.installerPackage,
            version: matrix.browser.installerVersion,
            name: matrix.browser.name,
            revision: matrix.browser.revision,
            browserVersion: matrix.browser.version,
            descriptorSha256: matrix.browser.browsersJsonSha256,
            installerIntegrity: matrix.browser.installerIntegrity,
            launcherIntegrity: matrix.browser.launcherIntegrity,
            coreIntegrity: matrix.browser.coreIntegrity,
            installerDirectorySha256:
              state.browserProvenance.installerDirectorySha256,
            launcherDirectorySha256:
              state.browserProvenance.launcherDirectorySha256,
            coreDirectorySha256: state.browserProvenance.coreDirectorySha256,
            executableFiles: state.browserProvenance.executableFiles,
            portableCacheSha256: state.browserProvenance.portableCacheSha256,
            installRootSha256: browserInstallSha256,
          }
        : null;
      const runId = sha256(
        canonicalJson({ project: project.id, mode, reset: resetState.sha256 })
      ).slice(0, 24);
      state.runLock = {
        schemaVersion: 1,
        bundleState: "final",
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
          nodeExecutable,
          nodeExecutableSha256: sha256File(nodeExecutable),
          npmExecutable,
          npmExecutableSha256: sha256File(npmExecutable),
          projectNpmrc: project.projectNpmrc,
          effectiveNpmSettings: effectiveNpmSettings(project),
          npmConfigSha256: resetState.value.npmConfiguration,
        },
        browser: browserEvidence,
        environment: selectedEnvironment,
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
          artifactStagingRoot,
          outsideRepositoryAncestry: true,
          linkScanSha256: state.linkScan.sha256,
          resetInputsSha256: resetState.sha256,
          reused,
          reuseUpdated,
          changedArtifactIds,
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
          closureBindingIds: project.closureBindings.map(
            (binding) => binding.id
          ),
        },
        artifacts: evidenceArtifacts.filter((artifact) =>
          projectArtifactIds(project).includes(artifact.artifactId)
        ),
        dependencyGraphs: state.graphs,
        origins: state.origins,
        internalPackages: state.internalPackages,
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
      const reason = error instanceof Error ? error : new Error(String(error));
      const failureText = `${reason.message}\n${state.currentStderr ?? ""}`;
      const waived =
        project.expectedResult === "waived-failure" &&
        state.currentPhase === project.expectedFailure.phase &&
        project.expectedFailure.contains.every((text) =>
          failureText.includes(text)
        );
      if (!waived) runFailed = true;
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
      const failureBrowser = state.browserProvenance
        ? {
            package: matrix.browser.installerPackage,
            version: matrix.browser.installerVersion,
            name: matrix.browser.name,
            revision: matrix.browser.revision,
            browserVersion: matrix.browser.version,
            descriptorSha256: matrix.browser.browsersJsonSha256,
            installerIntegrity: matrix.browser.installerIntegrity,
            launcherIntegrity: matrix.browser.launcherIntegrity,
            coreIntegrity: matrix.browser.coreIntegrity,
            installerDirectorySha256:
              state.browserProvenance.installerDirectorySha256,
            launcherDirectorySha256:
              state.browserProvenance.launcherDirectorySha256,
            coreDirectorySha256: state.browserProvenance.coreDirectorySha256,
            executableFiles: state.browserProvenance.executableFiles,
            portableCacheSha256: state.browserProvenance.portableCacheSha256,
            installRootSha256: directorySha256(
              path.join(runRoot, "browser-cache"),
              new Set([".links"])
            ),
          }
        : null;
      state.runLock = {
        schemaVersion: 1,
        bundleState: "final",
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
          nodeExecutable,
          nodeExecutableSha256: sha256File(nodeExecutable),
          npmExecutable,
          npmExecutableSha256: sha256File(npmExecutable),
          projectNpmrc: project.projectNpmrc,
          effectiveNpmSettings: effectiveNpmSettings(project),
          npmConfigSha256: resetState.value.npmConfiguration,
        },
        browser: failureBrowser,
        environment: state.selectedEnvironment ?? environment,
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
          artifactStagingRoot,
          outsideRepositoryAncestry: true,
          linkScanSha256: state.linkScan.sha256,
          resetInputsSha256: resetState.sha256,
          reused,
          reuseUpdated,
          changedArtifactIds,
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
          closureBindingIds: project.closureBindings.map(
            (binding) => binding.id
          ),
        },
        artifacts: evidenceArtifacts.filter((artifact) =>
          projectArtifactIds(project).includes(artifact.artifactId)
        ),
        dependencyGraphs: state.graphs,
        origins: state.origins,
        internalPackages: state.internalPackages,
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
          status: waived ? "waived-failure" : "failure",
          waiver: waived ? project.waiver : null,
          failureReason: failureText,
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
        status: waived ? "waived-failure" : "failure",
        runId: state.runLock.runId,
        mode,
        reused,
        reason: failureText,
        failureBundle: bundle.path,
        retainedSandbox: projectRoot,
        runLock: path.relative(outputRoot, failureRunLock),
        runLockSha256: sha256(canonicalJson(state.runLock)),
      });
      if (!waived) break;
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
    waived: results.filter((result) => result.status === "waived-failure")
      .length,
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
  if (
    mode !== "clean" ||
    runFailed ||
    selected.length !== runnable.length ||
    selected.some((project, index) => project.id !== runnable[index].id)
  )
    die("--write requires the complete successful clean runnable matrix");
  const dynamicVerification = commandResult(
    [
      process.execPath,
      path.join(repository, "tools/verify-integration-run.mjs"),
      "--root",
      outputRoot,
    ],
    repository
  );
  if (dynamicVerification.status !== 0)
    die(
      `refusing checked evidence: ${
        dynamicVerification.stderr || dynamicVerification.stdout
      }`
    );
  const evidenceDirectory = path.join(repository, "migration/evidence/i02");
  const checkedRunLocks = path.join(evidenceDirectory, "run-locks");
  const checkedFailureBundles = path.join(evidenceDirectory, "failure-bundles");
  rmSync(checkedRunLocks, { recursive: true, force: true });
  rmSync(checkedFailureBundles, { recursive: true, force: true });
  mkdirSync(checkedRunLocks, { recursive: true });
  mkdirSync(checkedFailureBundles, { recursive: true });
  const checkedSummary = JSON.parse(JSON.stringify(summary));
  checkedSummary.evidenceFormat = "compact-schema-validated-run-locks";
  for (const result of checkedSummary.results) {
    if (path.isAbsolute(result.runLock))
      die(`${result.fixtureId}: dynamic run lock path must be relative`);
    const source = path.resolve(outputRoot, result.runLock);
    if (!lexicallyInside(outputRoot, source))
      die(`${result.fixtureId}: dynamic run lock escapes output root`);
    const relative = `run-locks/${projectSlug(result.fixtureId)}.json`;
    const target = path.join(evidenceDirectory, relative);
    cpSync(source, target, { force: true });
    result.runLock = relative;
    const dynamicRunLock = JSON.parse(readFileSync(source, "utf8"));
    if (dynamicRunLock.failureBundle) {
      const bundleRelative = `failure-bundles/${projectSlug(result.fixtureId)}`;
      const bundleTarget = path.join(evidenceDirectory, bundleRelative);
      cpSync(dynamicRunLock.failureBundle.path, bundleTarget, {
        recursive: true,
      });
      result.checkedFailureBundle = bundleRelative;
    }
  }
  cpSync(
    path.join(evidenceArtifactDirectory, "hashes.json"),
    path.join(evidenceDirectory, "artifact-hashes.json"),
    { force: true }
  );
  for (const artifact of checkedSummary.artifacts)
    artifact.path = "artifact-hashes.json";
  writeFileSync(
    path.join(evidenceDirectory, "integration-proof.json"),
    `${JSON.stringify(checkedSummary, null, 2)}\n`
  );
  const checkedVerification = commandResult(
    [
      process.execPath,
      path.join(repository, "tools/verify-integration-evidence.mjs"),
    ],
    repository
  );
  if (checkedVerification.status !== 0)
    die(
      `refusing invalid checked evidence: ${
        checkedVerification.stderr || checkedVerification.stdout
      }`
    );
}
const hasWaivedFailure = results.some(
  (result) => result.status === "waived-failure"
);
if (mode === "clean" && !retain && !runFailed && !hasWaivedFailure)
  rmSync(runRoot, { recursive: true, force: true });
if (runFailed) {
  console.error(`INTEGRATION_MATRIX_RUN_FAILED output=${outputRoot}`);
  process.exit(1);
}
console.log(
  `INTEGRATION_MATRIX_RUN_OK mode=${mode} passed=${summary.counts.passed} waived=${summary.counts.waived} edges=${summary.counts.logicalEdges} browser=${summary.counts.browserProjects} output=${outputRoot}`
);
