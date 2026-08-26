#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  readdir,
  lstat,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  artifactStem,
  fail,
  packageRecordForCwd,
  repository,
  sha256,
  validatePackedFileList,
  validateSourceMapReferences,
} from "./package-artifacts-lib.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
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
  const directory = path.join(root, relative);
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink())
      fail(`packed artifact contains a symbolic link: ${child}`);
    if (entry.isDirectory()) files.push(...(await recursiveFiles(root, child)));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
    else fail(`packed artifact contains unsupported entry: ${child}`);
  }
  return files;
}

function textual(filename) {
  return /(?:\.d\.(?:ts|cts|mts)|\.(?:js|mjs|cjs|map|json))$/.test(filename);
}

function portableSourceMapReference(
  packageRecord,
  mapFilename,
  sourceRoot,
  source
) {
  if (typeof sourceRoot !== "string" || typeof source !== "string") {
    fail(
      `${packageRecord.id} source map ${mapFilename} has non-string source metadata`
    );
  }
  let reference = path.posix.join(sourceRoot, source);
  const scheme = reference.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme) {
    if (scheme[1].toLowerCase() !== "webpack") {
      fail(
        `${packageRecord.id} source map ${mapFilename} has non-portable URI source ${source}`
      );
    }
    const parts = reference
      .slice(scheme[0].length)
      .replace(/^\/+/, "")
      .split("/");
    if (parts.length > 1 && parts[1] === ".") parts.shift();
    reference = parts.join("/").replace(/^\.\//, "");
  }
  if (
    !reference ||
    path.posix.isAbsolute(reference) ||
    reference.includes("\\")
  ) {
    fail(
      `${packageRecord.id} source map ${mapFilename} has non-portable source ${source}`
    );
  }
  reference = path.posix.normalize(reference);
  const mapDirectory = path.posix.dirname(mapFilename);
  const resolved = path.posix.normalize(
    path.posix.join(mapDirectory, reference)
  );
  const checkoutRelative = reference.replace(/^(?:\.\.\/)+/, "");
  if (
    resolved === ".." ||
    resolved.startsWith("../") ||
    /^(?:core|frameworks|plugins|tools|node_modules)\//.test(checkoutRelative)
  ) {
    let portable = checkoutRelative
      .replace(/^node_modules\//, "dependencies/")
      .replace(/^core\/lib-esm\//, "dependencies/uirouter-core/");
    if (!portable.startsWith("dependencies/")) portable = `sources/${portable}`;
    reference = portable;
  } else {
    reference =
      path.posix.relative(mapDirectory, resolved) ||
      path.posix.basename(resolved);
  }
  return reference;
}

async function normalizeSourceMaps(packageRecord, packageRoot, packRoot) {
  const roots = packageRecord.pack.root
    ? [packRoot]
    : (packageRecord.build?.cleanPaths || []).map((entry) =>
        path.join(packageRoot, entry)
      );
  const maps = [];
  for (const root of roots) {
    if (await exists(root)) {
      for (const relative of await recursiveFiles(root)) {
        if (relative.endsWith(".map")) maps.push(path.join(root, relative));
      }
    }
  }
  for (const absolute of [...new Set(maps)].sort()) {
    const mapFilename = path
      .relative(packRoot, absolute)
      .split(path.sep)
      .join("/");
    let sourceMap;
    try {
      sourceMap = JSON.parse(await readFile(absolute, "utf8"));
    } catch {
      fail(`${packageRecord.id} has invalid source map ${mapFilename}`);
    }
    const sourceRoot = sourceMap.sourceRoot ?? "";
    if (!Array.isArray(sourceMap.sources)) {
      fail(
        `${packageRecord.id} source map ${mapFilename} has non-array sources`
      );
    }
    sourceMap.sources = sourceMap.sources.map((source) =>
      portableSourceMapReference(packageRecord, mapFilename, sourceRoot, source)
    );
    sourceMap.sourceRoot = "";
    validateSourceMapReferences(packageRecord.id, mapFilename, sourceMap);
    await writeFile(absolute, `${JSON.stringify(sourceMap)}\n`);
  }
}

async function inspectContent(contract, packageRecord, extractedPackage) {
  const sourceEntrypoints = JSON.parse(
    await readFile(
      path.join(repository, "migration/source-aliases.json"),
      "utf8"
    )
  ).edges.map((edge) => edge.sourceEntrypoint);
  const files = await recursiveFiles(extractedPackage);
  validatePackedFileList(contract, packageRecord, files);
  const fileRecords = [];
  for (const filename of files) {
    const absolute = path.join(extractedPackage, filename);
    const contents = await readFile(absolute);
    const metadata = await lstat(absolute);
    if (textual(filename)) {
      const text = contents.toString("utf8");
      for (const forbidden of [
        repository,
        repository.replaceAll(path.sep, "/"),
        "tools/source-aliases.cjs",
        "migration/source-aliases.json",
      ]) {
        if (text.includes(forbidden))
          fail(
            `${packageRecord.id} packed file ${filename} leaks ${forbidden}`
          );
      }
      const leakedEntrypoint = sourceEntrypoints.find((entrypoint) =>
        text.includes(entrypoint)
      );
      if (leakedEntrypoint)
        fail(
          `${packageRecord.id} packed file ${filename} leaks source entrypoint ${leakedEntrypoint}`
        );
      if (filename.endsWith(".map")) {
        let sourceMap;
        try {
          sourceMap = JSON.parse(text);
        } catch {
          fail(
            `${packageRecord.id} has invalid source map JSON in ${filename}`
          );
        }
        validateSourceMapReferences(packageRecord.id, filename, sourceMap);
      }
    }
    fileRecords.push({
      path: filename,
      mode: metadata.mode & 0o777,
      size: contents.length,
      sha256: sha256(contents),
    });
  }
  fileRecords.sort((left, right) => left.path.localeCompare(right.path));
  const packedManifest = JSON.parse(
    await readFile(path.join(extractedPackage, "package.json"), "utf8")
  );
  if (
    packedManifest.name !== packageRecord.package ||
    packedManifest.version !== packageRecord.version
  ) {
    fail(`${packageRecord.id} packed manifest identity differs`);
  }
  if (packageRecord.kind === "angular-library") {
    const exported = packedManifest.exports?.["."];
    const moduleEntry = packageRecord.entrypoints.find(
      (entrypoint) => entrypoint.mode === "node-import"
    );
    const typeEntry = packageRecord.entrypoints.find(
      (entrypoint) => entrypoint.mode === "types"
    );
    if (
      exported?.default?.replace(/^\.\//, "") !== moduleEntry?.target ||
      exported?.types?.replace(/^\.\//, "") !== typeEntry?.target ||
      packedManifest.module !== moduleEntry?.target ||
      packedManifest.typings !== typeEntry?.target ||
      packedManifest.type !== "module"
    ) {
      fail(
        `${packageRecord.id} generated ng-packagr entrypoints differ from the contract`
      );
    }
  }
  if (packageRecord.kind === "cli") {
    for (const entrypoint of packageRecord.entrypoints) {
      if (
        packedManifest.bin?.[entrypoint.specifier]?.replace(/^\.\//, "") !==
        entrypoint.target
      ) {
        fail(`${entrypoint.id} is missing from the packed bin map`);
      }
      const target = fileRecords.find(
        (file) => file.path === entrypoint.target
      );
      if (!target || (target.mode & 0o111) === 0)
        fail(
          `${entrypoint.id} target is not executable in the packed artifact`
        );
      const targetContents = await readFile(
        path.join(extractedPackage, entrypoint.target),
        "utf8"
      );
      if (!targetContents.startsWith("#!"))
        fail(`${entrypoint.id} target lacks an executable shebang`);
    }
  }
  return fileRecords;
}

let temporary;
try {
  const { contract, packageRecord, packageRoot } = await packageRecordForCwd(
    process.cwd()
  );
  const packRoot = path.resolve(packageRoot, packageRecord.pack.directory);
  const relation = path.relative(packageRoot, packRoot);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    fail(`${packageRecord.id} pack directory escapes the package`);
  }
  for (const required of packageRecord.pack.required) {
    try {
      await lstat(path.join(packRoot, required));
    } catch {
      fail(`${packageRecord.id} required pack input is missing: ${required}`);
    }
  }
  await normalizeSourceMaps(packageRecord, packageRoot, packRoot);

  temporary = await mkdtemp(path.join(os.tmpdir(), "uirouter-p01-pack-"));
  const packArgs = [...contract.artifactPolicy.npmPackArgv.slice(1), temporary];
  const environment = { ...process.env, ...contract.normalizedEnvironment };
  const packed = run(contract.artifactPolicy.npmPackArgv[0], packArgs, {
    cwd: packRoot,
    env: environment,
  });
  let result;
  try {
    const parsed = JSON.parse(packed.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1)
      fail(`${packageRecord.id} npm pack returned ${parsed.length} records`);
    [result] = parsed;
  } catch (error) {
    if (String(error).startsWith("Error: PACKAGE_ARTIFACTS_VERIFY_FAILED:"))
      throw error;
    fail(`${packageRecord.id} npm pack did not return JSON: ${error.message}`);
  }
  const filenames = result.files.map((file) => file.path).sort();
  validatePackedFileList(contract, packageRecord, filenames);
  const temporaryTarball = path.join(temporary, result.filename);
  const tarballContents = await readFile(temporaryTarball);
  const digest = sha256(tarballContents);
  const stem = artifactStem(
    packageRecord.package,
    packageRecord.version,
    digest
  );
  const artifactDirectory = path.join(
    packageRoot,
    contract.artifactPolicy.directory
  );
  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  const artifactFilename = `${stem}.tgz`;
  const artifactPath = path.join(artifactDirectory, artifactFilename);
  await copyFile(temporaryTarball, artifactPath);

  const extracted = path.join(temporary, "extracted");
  await mkdir(extracted);
  run(
    "tar",
    [
      "--extract",
      "--gzip",
      "--file",
      temporaryTarball,
      "--directory",
      extracted,
    ],
    { env: environment }
  );
  const extractedPackage = path.join(extracted, "package");
  const fileRecords = await inspectContent(
    contract,
    packageRecord,
    extractedPackage
  );
  assertNpmFileParity(result.files, fileRecords, packageRecord.id);

  const metadata = {
    schemaVersion: 1,
    artifactId: packageRecord.id,
    package: packageRecord.package,
    version: packageRecord.version,
    filename: artifactFilename,
    sha256: digest,
    shasum: result.shasum,
    integrity: result.integrity,
    size: tarballContents.length,
    unpackedSize: result.unpackedSize,
    files: fileRecords,
  };
  await writeFile(
    path.join(artifactDirectory, `${stem}.json`),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
  console.log(
    `P01_PACK_OK package=${packageRecord.package} files=${fileRecords.length} sha256=${digest}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}

function assertNpmFileParity(npmFiles, extractedFiles, packageId) {
  const expected = npmFiles
    .map((file) => ({
      path: file.path,
      mode: file.mode & 0o777,
      size: file.size,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const actual = extractedFiles.map((file) => ({
    path: file.path,
    mode: file.mode,
    size: file.size,
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${packageId} npm pack metadata differs from extracted archive contents`
    );
  }
}
