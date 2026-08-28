#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  artifactStem,
  canonicalJson,
  contractPath,
  fail,
  repository,
  sha256,
  sha256File,
  validatePackageArtifactsContract,
} from "./package-artifacts-lib.mjs";

const writeEvidence = process.argv.includes("--write");
const unexpected = process.argv
  .slice(2)
  .filter((argument) => argument !== "--write");
if (unexpected.length) fail(`unknown arguments: ${unexpected.join(" ")}`);

const evidenceDirectory = path.join(repository, "migration/evidence/p01");
const evidenceFile = path.join(evidenceDirectory, "package-proof.json");
const consumerLockFile = path.join(
  evidenceDirectory,
  "consumer-package-lock.json"
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== (options.expectedStatus ?? 0)) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status})\n${
        result.stdout || ""
      }${result.stderr || ""}`
    );
  }
  return result;
}

async function exists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch {
    return false;
  }
}

async function recursiveFiles(root, relative = "") {
  if (!(await exists(root))) return [];
  const entries = (
    await readdir(path.join(root, relative), { withFileTypes: true })
  ).sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink())
      fail(`artifact output contains symbolic link ${child}`);
    if (entry.isDirectory()) files.push(...(await recursiveFiles(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
    else fail(`artifact output contains unsupported entry ${child}`);
  }
  return files;
}

async function sourceSnapshot(contract) {
  const excludedPrefixes = new Set([
    "migration/evidence/p01/package-proof.json",
    "migration/evidence/p01/consumer-package-lock.json",
  ]);
  for (const record of contract.packages) {
    const packageDirectory = path.posix.dirname(record.manifest);
    for (const cleanPath of record.build?.cleanPaths || []) {
      excludedPrefixes.add(path.posix.join(packageDirectory, cleanPath));
    }
    excludedPrefixes.add(
      path.posix.join(packageDirectory, contract.artifactPolicy.directory)
    );
  }
  const ignoredNames = new Set([
    ".git",
    ".turbo",
    ".artifacts",
    ".integration-cache",
    ".migration-work",
    "node_modules",
  ]);
  const records = [];
  async function walk(relative = "") {
    const entries = (
      await readdir(path.join(repository, relative), { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      const portable = child.split(path.sep).join("/");
      if (ignoredNames.has(entry.name)) continue;
      if (
        [...excludedPrefixes].some(
          (prefix) => portable === prefix || portable.startsWith(`${prefix}/`)
        )
      )
        continue;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const contents = await readFile(path.join(repository, child));
        records.push({
          path: portable,
          size: contents.length,
          sha256: sha256(contents),
        });
      } else if (entry.isSymbolicLink()) {
        records.push({
          path: portable,
          symlink: await readlink(path.join(repository, child)),
        });
      } else fail(`source snapshot contains unsupported entry ${portable}`);
    }
  }
  await walk();
  return records;
}

async function cleanOutputs(contract) {
  for (const record of contract.packages) {
    const packageRoot = path.join(
      repository,
      path.posix.dirname(record.manifest)
    );
    for (const cleanPath of record.build?.cleanPaths || []) {
      await rm(path.join(packageRoot, cleanPath), {
        recursive: true,
        force: true,
      });
    }
    await rm(path.join(packageRoot, contract.artifactPolicy.directory), {
      recursive: true,
      force: true,
    });
  }
}

async function buildSnapshot(contract) {
  const files = [];
  for (const record of contract.packages.filter(
    (candidate) => candidate.build
  )) {
    const packageRoot = path.join(
      repository,
      path.posix.dirname(record.manifest)
    );
    for (const pattern of record.build.outputs) {
      const outputRoot = pattern.replace(/\/\*\*$/, "");
      const absoluteRoot = path.join(packageRoot, outputRoot);
      const outputFiles = await recursiveFiles(absoluteRoot);
      if (!outputFiles.length)
        fail(`${record.id} build output ${outputRoot} is empty`);
      for (const relative of outputFiles) {
        const filename = path.posix.join(
          path.posix.dirname(record.manifest),
          outputRoot,
          relative
        );
        const contents = await readFile(path.join(absoluteRoot, relative));
        files.push({
          path: filename,
          size: contents.length,
          sha256: sha256(contents),
        });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const duplicate = files.find(
    (file, index) => index > 0 && files[index - 1].path === file.path
  );
  if (duplicate) fail(`build snapshot repeats ${duplicate.path}`);
  return files;
}

async function collectArtifacts(contract, destination) {
  await mkdir(destination, { recursive: true });
  const artifacts = [];
  for (const record of contract.packages) {
    const packageRoot = path.join(
      repository,
      path.posix.dirname(record.manifest)
    );
    const artifactRoot = path.join(
      packageRoot,
      contract.artifactPolicy.directory
    );
    const names = (await readdir(artifactRoot)).sort();
    const jsonNames = names.filter((name) => name.endsWith(".json"));
    const tarballNames = names.filter((name) => name.endsWith(".tgz"));
    if (jsonNames.length !== 1 || tarballNames.length !== 1)
      fail(`${record.id} did not emit one metadata file and one tarball`);
    const metadata = JSON.parse(
      await readFile(path.join(artifactRoot, jsonNames[0]), "utf8")
    );
    if (
      metadata.artifactId !== record.id ||
      metadata.package !== record.package ||
      metadata.version !== record.version
    ) {
      fail(`${record.id} artifact metadata identity differs`);
    }
    const expectedFilename = `${artifactStem(
      record.package,
      record.version,
      metadata.sha256
    )}.tgz`;
    if (
      metadata.filename !== tarballNames[0] ||
      metadata.filename !== expectedFilename ||
      path.posix.basename(metadata.filename) !== metadata.filename
    ) {
      fail(
        `${record.id} artifact filename is not the exact content-addressed basename`
      );
    }
    const tarball = path.join(artifactRoot, tarballNames[0]);
    if ((await sha256File(tarball)) !== metadata.sha256)
      fail(`${record.id} tarball digest differs from metadata`);
    await copyFile(tarball, path.join(destination, metadata.filename));
    artifacts.push({
      artifactId: metadata.artifactId,
      package: metadata.package,
      version: metadata.version,
      filename: metadata.filename,
      sha256: metadata.sha256,
      shasum: metadata.shasum,
      integrity: metadata.integrity,
      size: metadata.size,
      unpackedSize: metadata.unpackedSize,
      fileCount: metadata.files.length,
      filesSha256: sha256(canonicalJson(metadata.files)),
      files: metadata.files,
    });
  }
  return artifacts.sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId)
  );
}

async function runCycle(contract, proofRoot, cycle) {
  await cleanOutputs(contract);
  const environment = { ...process.env, ...contract.normalizedEnvironment };
  run("npm", ["run", "pack", "--", "--output-logs=errors-only"], {
    cwd: repository,
    env: environment,
  });
  const outputs = await buildSnapshot(contract);
  const artifacts = await collectArtifacts(
    contract,
    path.join(proofRoot, "artifacts")
  );
  return {
    cycle,
    buildFileCount: outputs.length,
    buildSha256: sha256(canonicalJson(outputs)),
    outputs,
    artifacts,
  };
}

function withoutFileDetails(cycle) {
  return {
    buildFileCount: cycle.buildFileCount,
    buildSha256: cycle.buildSha256,
    artifacts: cycle.artifacts.map(({ files, ...artifact }) => artifact),
  };
}

function assertCyclesEqual(first, second) {
  if (canonicalJson(first.outputs) !== canonicalJson(second.outputs))
    fail("repeated clean build output trees differ");
  if (canonicalJson(first.artifacts) !== canonicalJson(second.artifacts))
    fail("repeated content-addressed package artifacts differ");
}

function normalizedDependencyGraph(lock) {
  return Object.entries(lock.packages || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({
      key,
      name: value.name || null,
      version: value.version || null,
      resolved: value.resolved || null,
      integrity: value.integrity || null,
      link: value.link || false,
    }));
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function verifyInstalledPackages(contract, artifacts, consumerRoot) {
  const lock = JSON.parse(
    await readFile(path.join(consumerRoot, "package-lock.json"), "utf8")
  );
  const artifactByPackage = new Map(
    artifacts.map((artifact) => [artifact.package, artifact])
  );
  let installedFiles = 0;
  for (const record of contract.packages) {
    const artifact = artifactByPackage.get(record.package);
    const key = `node_modules/${record.package}`;
    const lockRecord = lock.packages[key];
    if (!lockRecord) fail(`${record.package} is absent from the consumer lock`);
    if (
      lockRecord.version !== record.version ||
      lockRecord.integrity !== artifact.integrity
    ) {
      fail(`${record.package} consumer lock version/integrity differs`);
    }
    if (lockRecord.resolved !== `file:../artifacts/${artifact.filename}`) {
      fail(
        `${record.package} consumer lock did not resolve the content-addressed local tarball`
      );
    }
    const installedRoot = path.join(consumerRoot, key);
    const metadata = await lstat(installedRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail(
        `${record.package} installed origin is not a physical package directory`
      );
    const realInstalled = await realpath(installedRoot);
    if (!pathInside(await realpath(consumerRoot), realInstalled))
      fail(`${record.package} resolves outside the consumer sandbox`);
    const installedManifest = JSON.parse(
      await readFile(path.join(installedRoot, "package.json"), "utf8")
    );
    if (
      installedManifest.name !== record.package ||
      installedManifest.version !== record.version
    ) {
      fail(`${record.package} installed manifest identity differs`);
    }
    for (const file of artifact.files) {
      const installed = path.join(installedRoot, file.path);
      const fileMetadata = await lstat(installed);
      if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink())
        fail(`${record.package} installed file origin differs: ${file.path}`);
      const contents = await readFile(installed);
      if (contents.length !== file.size || sha256(contents) !== file.sha256) {
        fail(
          `${record.package} installed file differs from packed artifact: ${file.path}`
        );
      }
      installedFiles += 1;
    }
  }
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/@uirouter/")) continue;
    const packageName = key.slice("node_modules/".length);
    if (!artifactByPackage.has(packageName))
      fail(`consumer lock contains undeclared internal package ${packageName}`);
    if (!String(value.resolved || "").startsWith("file:../artifacts/"))
      fail(`consumer lock uses registry fallback for ${packageName}`);
  }
  return { lock, installedFiles };
}

function runtimeProbeSource(contract) {
  const requireEntries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "require");
  const importEntries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "node-import");
  return `
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
require('angular/angular');
globalThis.angular = globalThis.window.angular;
const requireEntries = ${JSON.stringify(requireEntries)};
for (const entry of requireEntries) {
  const loaded = require(entry.specifier);
  if (!(entry.export in loaded)) throw new Error(entry.id + ' missing export ' + entry.export);
}
await import('@angular/compiler');
const importEntries = ${JSON.stringify(importEntries)};
for (const entry of importEntries) {
  const loaded = await import(entry.specifier);
  if (!(entry.export in loaded)) throw new Error(entry.id + ' missing export ' + entry.export);
}
const { UIRouter } = require('@uirouter/core');
const router = new UIRouter();
router.stateRegistry.register({ name: 'p01', url: '/p01' });
if (!router.stateRegistry.get('p01')) throw new Error('core minimal router flow failed');
let sentinelResolved = false;
try { require.resolve(${JSON.stringify(
    contract.consumer.sentinelPackage
  )}); sentinelResolved = true; } catch {}
if (sentinelResolved) throw new Error('root-only sentinel resolved from packed consumer');
console.log('P01_RUNTIME_PROBES_OK require=' + requireEntries.length + ' import=' + importEntries.length);
`;
}

function bundlerProbeSource(contract) {
  const entries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "bundler-import");
  return `${entries
    .map(
      (entrypoint, index) =>
        `import { ${entrypoint.export} as value${index} } from ${JSON.stringify(
          entrypoint.specifier
        )};`
    )
    .join("\n")}\nconsole.log(${entries
    .map((_, index) => `Boolean(value${index})`)
    .join(" && ")});\n`;
}

function typeProbeSource(contract) {
  const entries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "types");
  return `${entries
    .map(
      (entrypoint, index) =>
        `import { ${
          entrypoint.export
        } as TypeValue${index} } from ${JSON.stringify(
          entrypoint.specifier
        )};\ntype P01Type${index} = typeof TypeValue${index};`
    )
    .join("\n")}\nexport type P01Types = ${entries
    .map((_, index) => `P01Type${index}`)
    .join(" & ")};\n`;
}

async function verifyBins(contract, consumerRoot) {
  const cli = contract.packages.find((record) => record.kind === "cli");
  const installedRoot = path.join(consumerRoot, "node_modules", cli.package);
  const manifest = JSON.parse(
    await readFile(path.join(installedRoot, "package.json"), "utf8")
  );
  for (const entrypoint of cli.entrypoints) {
    if (
      manifest.bin?.[entrypoint.specifier]?.replace(/^\.\//, "") !==
      entrypoint.target
    )
      fail(`${entrypoint.id} installed bin map differs`);
    const bin = path.join(
      consumerRoot,
      "node_modules/.bin",
      entrypoint.specifier
    );
    const binRealpath = await realpath(bin);
    if (!pathInside(installedRoot, binRealpath))
      fail(`${entrypoint.id} installed bin escapes its tarball package`);
    const target = await readFile(binRealpath, "utf8");
    if (!target.startsWith("#!"))
      fail(`${entrypoint.id} installed bin lacks a shebang`);
  }
  return cli.entrypoints.length;
}

function consumerArtifactReferences(lock) {
  const dependencies = JSON.parse(lock.toString("utf8")).packages?.[""]
    ?.dependencies;
  if (!dependencies || typeof dependencies !== "object") return {};
  return Object.fromEntries(
    Object.entries(dependencies)
      .filter(
        ([packageName, specifier]) =>
          packageName.startsWith("@uirouter/") &&
          typeof specifier === "string" &&
          specifier.startsWith("file:../artifacts/")
      )
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function consumerLockDifference(expectedLock, generatedLock) {
  const expectedReferences = consumerArtifactReferences(expectedLock);
  const generatedReferences = consumerArtifactReferences(generatedLock);
  const packageNames = new Set([
    ...Object.keys(expectedReferences),
    ...Object.keys(generatedReferences),
  ]);
  const artifactReferences = [...packageNames]
    .sort()
    .filter(
      (packageName) =>
        expectedReferences[packageName] !== generatedReferences[packageName]
    )
    .map((packageName) => ({
      package: packageName,
      expected: expectedReferences[packageName] ?? null,
      generated: generatedReferences[packageName] ?? null,
    }));
  return JSON.stringify({
    expectedSha256: sha256(expectedLock),
    generatedSha256: sha256(generatedLock),
    artifactReferences,
  });
}

async function runConsumer(contract, artifacts, proofRoot) {
  const consumerRoot = path.join(proofRoot, "consumer");
  await mkdir(consumerRoot);
  const dependencies = { ...contract.consumer.dependencies };
  dependencies.typescript = contract.consumer.typecheck.typescript;
  dependencies[contract.consumer.bundler.package] =
    contract.consumer.bundler.version;
  for (const artifact of artifacts)
    dependencies[artifact.package] = `file:../artifacts/${artifact.filename}`;
  const manifest = {
    name: contract.consumer.name,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
  };
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const environment = {
    ...process.env,
    ...contract.normalizedEnvironment,
    HOME: path.join(proofRoot, "home"),
  };
  delete environment.NODE_PATH;
  await mkdir(environment.HOME);
  run(contract.consumer.lockArgv[0], contract.consumer.lockArgv.slice(1), {
    cwd: consumerRoot,
    env: environment,
  });
  const generatedLock = await readFile(
    path.join(consumerRoot, "package-lock.json")
  );
  if (writeEvidence) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(consumerLockFile, generatedLock);
  } else {
    const expectedLock = await readFile(consumerLockFile);
    if (!generatedLock.equals(expectedLock))
      fail(
        `packed-consumer lock differs from checked-in evidence: ${consumerLockDifference(
          expectedLock,
          generatedLock
        )}`
      );
  }
  run(
    contract.consumer.installArgv[0],
    contract.consumer.installArgv.slice(1),
    { cwd: consumerRoot, env: environment }
  );
  const { lock, installedFiles } = await verifyInstalledPackages(
    contract,
    artifacts,
    consumerRoot
  );
  const npmLs = run("npm", ["ls", "--all", "--json"], {
    cwd: consumerRoot,
    env: environment,
  });
  const npmLsJson = JSON.parse(npmLs.stdout);
  if (npmLsJson.problems?.length)
    fail(`packed consumer npm ls reports ${npmLsJson.problems.join("; ")}`);

  await writeFile(
    path.join(consumerRoot, "runtime-probe.mjs"),
    runtimeProbeSource(contract)
  );
  const runtime = run("node", ["runtime-probe.mjs"], {
    cwd: consumerRoot,
    env: environment,
  });
  if (!runtime.stdout.includes("P01_RUNTIME_PROBES_OK"))
    fail("runtime probe did not report success");

  await writeFile(
    path.join(consumerRoot, "bundler-probe.ts"),
    bundlerProbeSource(contract)
  );
  run(
    contract.consumer.bundler.command[0],
    contract.consumer.bundler.command.slice(1),
    { cwd: consumerRoot, env: environment }
  );

  await writeFile(
    path.join(consumerRoot, "types-probe.ts"),
    typeProbeSource(contract)
  );
  await writeFile(
    path.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
        },
        files: ["types-probe.ts"],
      },
      null,
      2
    )}\n`
  );
  run(
    contract.consumer.typecheck.command[0],
    contract.consumer.typecheck.command.slice(1),
    { cwd: consumerRoot, env: environment }
  );
  const bins = await verifyBins(contract, consumerRoot);

  const graph = normalizedDependencyGraph(lock);
  return {
    lockSha256: sha256(generatedLock),
    dependencyRecords: graph.length,
    dependencyGraphSha256: sha256(canonicalJson(graph)),
    internalPackages: contract.packages.length,
    installedFiles,
    entrypoints: contract.packages.reduce(
      (count, record) => count + record.entrypoints.length,
      0
    ),
    requireProbes: contract.packages
      .flatMap((record) => record.entrypoints)
      .filter((entrypoint) => entrypoint.mode === "require").length,
    nodeImportProbes: contract.packages
      .flatMap((record) => record.entrypoints)
      .filter((entrypoint) => entrypoint.mode === "node-import").length,
    bundlerProbes: contract.packages
      .flatMap((record) => record.entrypoints)
      .filter((entrypoint) => entrypoint.mode === "bundler-import").length,
    typeProbes: contract.packages
      .flatMap((record) => record.entrypoints)
      .filter((entrypoint) => entrypoint.mode === "types").length,
    binProbes: bins,
    sentinelRejected: true,
  };
}

let proofRoot;
let sentinelRoot;
let sentinelCreated = false;
try {
  const { contract, productionEdges } =
    await validatePackageArtifactsContract();
  const beforeSource = await sourceSnapshot(contract);
  proofRoot = await mkdtemp(path.join(os.tmpdir(), "uirouter-p01-proof-"));
  const realProof = await realpath(proofRoot);
  if (
    pathInside(await realpath(repository), realProof) ||
    pathInside(realProof, await realpath(repository))
  ) {
    fail("proof sandbox must be outside repository ancestry");
  }
  sentinelRoot = path.join(
    repository,
    "node_modules",
    ...contract.consumer.sentinelPackage.split("/")
  );
  if (await exists(sentinelRoot)) {
    fail(`root-only sentinel path already exists: ${sentinelRoot}`);
  }
  await mkdir(sentinelRoot, { recursive: true });
  sentinelCreated = true;
  await writeFile(
    path.join(sentinelRoot, "package.json"),
    `${JSON.stringify({
      name: contract.consumer.sentinelPackage,
      version: "0.0.0",
    })}\n`
  );
  await writeFile(
    path.join(sentinelRoot, "index.js"),
    "module.exports = true;\n"
  );

  const first = await runCycle(contract, proofRoot, 1);
  const second = await runCycle(contract, proofRoot, 2);
  assertCyclesEqual(first, second);
  const consumer = await runConsumer(contract, second.artifacts, proofRoot);

  const evidence = {
    schemaVersion: 1,
    task: "P01",
    owner: "ui-router-maintainers",
    contractSha256: await sha256File(path.join(repository, contractPath)),
    rootLockSha256: contract.rootLockSha256,
    runtime: contract.runtime,
    normalizedEnvironment: contract.normalizedEnvironment,
    repetitions: contract.artifactPolicy.repetitions,
    builds: {
      fileCount: first.buildFileCount,
      sha256: first.buildSha256,
      identical: true,
    },
    packages: withoutFileDetails(first).artifacts,
    productionEdges: productionEdges.length,
    consumer,
    waivers: [],
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (writeEvidence) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(evidenceFile, serialized);
  } else {
    const expected = await readFile(evidenceFile, "utf8");
    if (serialized !== expected)
      fail("package proof differs from checked-in evidence");
  }

  await rm(sentinelRoot, { recursive: true, force: true });
  sentinelCreated = false;
  sentinelRoot = undefined;
  const afterSource = await sourceSnapshot(contract);
  if (canonicalJson(afterSource) !== canonicalJson(beforeSource))
    fail("package proof changed repository source files");
  console.log(
    `PACKAGE_ARTIFACTS_PROOF_OK packages=${evidence.packages.length} buildFiles=${evidence.builds.fileCount} edges=${evidence.productionEdges} consumerRecords=${consumer.dependencyRecords} entrypoints=${consumer.entrypoints} repetitions=${evidence.repetitions}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (sentinelRoot && sentinelCreated)
    await rm(sentinelRoot, { recursive: true, force: true });
  if (proofRoot) await rm(proofRoot, { recursive: true, force: true });
}
