#!/usr/bin/env node

import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
);
function fail(message) {
  throw new Error(`CI_PACKAGE_STAGE_FAILED: ${message}`);
}
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== "--output" || !process.argv[index + 1])
    fail(`unknown argument ${process.argv[index]}`);
  index += 1;
}
const argument = value("--output");
if (!argument) fail("--output is required");
const output = path.resolve(repository, argument);
const allowed = path.join(repository, ".ci-artifacts");
const relation = path.relative(allowed, output);
if (relation.startsWith("..") || path.isAbsolute(relation) || relation === "")
  fail("output must be a child of .ci-artifacts");
function rejectSymlinkComponents(candidate) {
  let current = path.parse(candidate).root;
  for (const component of path.relative(current, candidate).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      fail(`symlinked path component: ${current}`);
  }
}
rejectSymlinkComponents(output);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const sha256File = (filename) => sha256(readFileSync(filename));
const readJson = (relative) =>
  JSON.parse(readFileSync(path.join(repository, relative), "utf8"));
const contractBytes = readFileSync(
  path.join(repository, "migration/ci-gates.json")
);
const ci = JSON.parse(contractBytes);
const packageContractBytes = readFileSync(
  path.join(repository, "migration/package-artifacts.json")
);
if (sha256(packageContractBytes) !== ci.bindings.packageArtifactsSha256)
  fail("package artifact binding differs");
const packageContract = JSON.parse(packageContractBytes);
const proofPath = path.join(
  repository,
  "migration/evidence/p01/package-proof.json"
);
const proofBytes = readFileSync(proofPath);
const proof = JSON.parse(proofBytes);
const proofById = new Map(
  proof.packages.map((record) => [record.artifactId, record])
);
const packageById = new Map(
  packageContract.packages.map((record) => [record.id, record])
);
const records = [];
for (const artifactId of ci.artifacts.packages.artifactIds) {
  const packageRecord = packageById.get(artifactId);
  const evidence = proofById.get(artifactId);
  if (
    !packageRecord ||
    !evidence ||
    evidence.package !== packageRecord.package ||
    evidence.version !== packageRecord.version
  )
    fail(`${artifactId} contract/proof identity differs`);
  const packageRoot = path.dirname(
    path.join(repository, packageRecord.manifest)
  );
  const artifactRoot = path.join(
    packageRoot,
    packageContract.artifactPolicy.directory
  );
  rejectSymlinkComponents(artifactRoot);
  if (!existsSync(artifactRoot) || lstatSync(artifactRoot).isSymbolicLink())
    fail(`${artifactId} artifact directory is missing or linked`);
  const names = readdirSync(artifactRoot).sort();
  const tgz = names.filter((name) => name.endsWith(".tgz"));
  const metadataFiles = names.filter((name) => name.endsWith(".json"));
  if (tgz.length !== 1 || metadataFiles.length !== 1)
    fail(`${artifactId} must have one archive and metadata file`);
  const metadata = JSON.parse(
    readFileSync(path.join(artifactRoot, metadataFiles[0]), "utf8")
  );
  const source = path.join(artifactRoot, tgz[0]);
  const digest = sha256File(source);
  if (
    metadata.artifactId !== artifactId ||
    metadata.filename !== tgz[0] ||
    metadata.sha256 !== digest ||
    evidence.filename !== tgz[0] ||
    evidence.sha256 !== digest ||
    evidence.integrity !== metadata.integrity
  )
    fail(`${artifactId} metadata/proof/archive differs`);
  const destination = path.join(output, tgz[0]);
  copyFileSync(source, destination);
  const sourceInfo = statSync(source);
  const destinationInfo = statSync(destination);
  if (
    sourceInfo.dev === destinationInfo.dev &&
    sourceInfo.ino === destinationInfo.ino
  )
    fail(`${artifactId} was hard linked`);
  if (sha256File(destination) !== digest)
    fail(`${artifactId} staged digest differs`);
  records.push({
    artifactId,
    package: evidence.package,
    version: evidence.version,
    filename: evidence.filename,
    sha256: evidence.sha256,
    integrity: evidence.integrity,
    size: evidence.size,
    fileCount: evidence.fileCount,
    metadataSha256: sha256(
      readFileSync(path.join(artifactRoot, metadataFiles[0]))
    ),
    filesSha256: evidence.filesSha256,
  });
}
const expectedFiles = new Set(records.map((record) => record.filename));
for (const filename of readdirSync(output))
  if (!expectedFiles.has(filename)) fail(`unexpected staged file ${filename}`);
const git = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
});
if (git.status !== 0 || !/^[0-9a-f]{40}$/.test(git.stdout.trim()))
  fail("cannot bind repository revision");
const manifest = {
  schemaVersion: 1,
  owner: ci.owner,
  repositoryRevision: process.env.GITHUB_SHA ?? git.stdout.trim(),
  ciContractSha256: sha256(contractBytes),
  packageArtifactsSha256: sha256(packageContractBytes),
  packageProofSha256: sha256(proofBytes),
  runtime: {
    node: process.version.slice(1),
    npm: spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim(),
    architecture: process.arch,
  },
  artifacts: records,
};
if (!/^[0-9a-f]{40}$/.test(manifest.repositoryRevision))
  fail("repository revision is not a full commit id");
const target = path.join(output, "hashes.json");
const temporary = `${target}.tmp-${process.pid}`;
writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
renameSync(temporary, target);
console.log(
  `CI_PACKAGE_ARTIFACTS_OK packages=${records.length} output=${argument}`
);
