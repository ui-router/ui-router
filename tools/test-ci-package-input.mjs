#!/usr/bin/env node

import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

import { repository, validateCiPackageInput } from "./ci-package-input-lib.mjs";

const index = process.argv.indexOf("--input");
if (index === -1 || !process.argv[index + 1] || process.argv.length !== 4)
  throw new Error("CI_PACKAGE_INPUT_TEST_FAILED: --input is required");
const source = path.resolve(repository, process.argv[index + 1]);
validateCiPackageInput(source);
let cases = 0;
const temporaryRoot = path.join(repository, ".migration-work");
mkdirSync(temporaryRoot, { recursive: true });
const temporary = mkdtempSync(path.join(temporaryRoot, "c01-input-"));
function manifest(directory) {
  return JSON.parse(readFileSync(path.join(directory, "hashes.json"), "utf8"));
}
function writeManifest(directory, value) {
  writeFileSync(
    path.join(directory, "hashes.json"),
    `${JSON.stringify(value, null, 2)}\n`
  );
}
function reject(name, mutate) {
  const directory = path.join(
    temporary,
    `${String(cases).padStart(2, "0")}-${name}`
  );
  cpSync(source, directory, { recursive: true });
  mutate(directory);
  let rejected = false;
  try {
    validateCiPackageInput(directory);
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error(`CI_PACKAGE_INPUT_TEST_FAILED: accepted ${name}`);
  cases += 1;
}
try {
  reject("missing-manifest", (directory) =>
    rmSync(path.join(directory, "hashes.json"))
  );
  reject("linked-manifest", (directory) => {
    const target = path.join(directory, "manifest-target.json");
    writeFileSync(target, readFileSync(path.join(directory, "hashes.json")));
    rmSync(path.join(directory, "hashes.json"));
    symlinkSync(target, path.join(directory, "hashes.json"));
  });
  reject("missing-archive", (directory) =>
    rmSync(path.join(directory, manifest(directory).artifacts[0].filename))
  );
  reject("changed-archive", (directory) =>
    writeFileSync(
      path.join(directory, manifest(directory).artifacts[0].filename),
      "changed"
    )
  );
  reject("linked-archive", (directory) => {
    const filename = manifest(directory).artifacts[0].filename;
    const target = path.join(directory, "linked-target.tgz");
    writeFileSync(target, readFileSync(path.join(directory, filename)));
    rmSync(path.join(directory, filename));
    symlinkSync(target, path.join(directory, filename));
  });
  reject("extra-file", (directory) =>
    writeFileSync(path.join(directory, "extra"), "extra")
  );
  reject("wrong-revision", (directory) => {
    const value = manifest(directory);
    value.repositoryRevision = "0".repeat(40);
    writeManifest(directory, value);
  });
  reject("wrong-ci-binding", (directory) => {
    const value = manifest(directory);
    value.ciContractSha256 = "0".repeat(64);
    writeManifest(directory, value);
  });
  reject("wrong-package-binding", (directory) => {
    const value = manifest(directory);
    value.packageArtifactsSha256 = "0".repeat(64);
    writeManifest(directory, value);
  });
  reject("wrong-proof-binding", (directory) => {
    const value = manifest(directory);
    value.packageProofSha256 = "0".repeat(64);
    writeManifest(directory, value);
  });
  reject("wrong-runtime", (directory) => {
    const value = manifest(directory);
    value.runtime.node = "0.0.0";
    writeManifest(directory, value);
  });
  reject("missing-record", (directory) => {
    const value = manifest(directory);
    value.artifacts.pop();
    writeManifest(directory, value);
  });
  reject("duplicate-record", (directory) => {
    const value = manifest(directory);
    value.artifacts[1] = value.artifacts[0];
    writeManifest(directory, value);
  });
  reject("wrong-integrity", (directory) => {
    const value = manifest(directory);
    value.artifacts[0].integrity = "sha512-wrong";
    writeManifest(directory, value);
  });
  reject("wrong-files-digest", (directory) => {
    const value = manifest(directory);
    value.artifacts[0].filesSha256 = "0".repeat(64);
    writeManifest(directory, value);
  });
  reject("unsafe-filename", (directory) => {
    const value = manifest(directory);
    value.artifacts[0].filename = "../escape.tgz";
    writeManifest(directory, value);
  });
  reject("hard-linked-repository-archive", (directory) => {
    const value = manifest(directory);
    const record = value.artifacts[0];
    const packageContract = JSON.parse(
      readFileSync(
        path.join(repository, "migration/package-artifacts.json"),
        "utf8"
      )
    );
    const packageRecord = packageContract.packages.find(
      (candidate) => candidate.id === record.artifactId
    );
    const local = path.join(
      repository,
      path.posix.dirname(packageRecord.manifest),
      packageContract.artifactPolicy.directory,
      record.filename
    );
    rmSync(path.join(directory, record.filename));
    linkSync(local, path.join(directory, record.filename));
  });
  console.log(`CI_PACKAGE_INPUT_ADVERSARIAL_OK cases=${cases}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
