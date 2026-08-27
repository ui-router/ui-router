import crypto from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repository = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
);
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const sha256File = (filename) => sha256(readFileSync(filename));
function fail(message) {
  throw new Error(`CI_PACKAGE_INPUT_FAILED: ${message}`);
}
function rejectSymlinkComponents(candidate) {
  let current = path.parse(candidate).root;
  for (const component of path.relative(current, candidate).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      fail(`symlinked path component: ${current}`);
  }
}
function gitRevision(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim()))
    fail("cannot derive repository revision");
  return result.stdout.trim();
}
export function validateCiPackageInput(input, options = {}) {
  const root = options.repository ?? repository;
  const directory = path.resolve(root, input);
  rejectSymlinkComponents(directory);
  if (
    !existsSync(directory) ||
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  )
    fail("input is not a physical directory");
  const manifestPath = path.join(directory, "hashes.json");
  if (
    !existsSync(manifestPath) ||
    !lstatSync(manifestPath).isFile() ||
    lstatSync(manifestPath).isSymbolicLink()
  )
    fail("hashes.json is missing or linked");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const packageContractPath = path.join(
    root,
    "migration/package-artifacts.json"
  );
  const proofPath = path.join(
    root,
    "migration/evidence/p01/package-proof.json"
  );
  const ciContractPath = path.join(root, "migration/ci-gates.json");
  const packageContract = JSON.parse(readFileSync(packageContractPath, "utf8"));
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  const ci = JSON.parse(readFileSync(ciContractPath, "utf8"));
  const expectedRevision = options.repositoryRevision ?? gitRevision(root);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.owner !== ci.owner ||
    manifest.repositoryRevision !== expectedRevision ||
    manifest.ciContractSha256 !== sha256File(ciContractPath) ||
    manifest.packageArtifactsSha256 !== sha256File(packageContractPath) ||
    manifest.packageProofSha256 !== sha256File(proofPath) ||
    manifest.runtime?.node !== ci.runtime.node ||
    manifest.runtime?.npm !== ci.runtime.npm ||
    manifest.runtime?.architecture !== process.arch
  )
    fail("manifest identity, binding, or runtime differs");
  if (!Array.isArray(manifest.artifacts))
    fail("manifest artifacts are missing");
  const expectedIds = packageContract.packages
    .map((record) => record.id)
    .sort();
  const suppliedIds = manifest.artifacts
    .map((record) => record.artifactId)
    .sort();
  if (
    new Set(suppliedIds).size !== suppliedIds.length ||
    JSON.stringify(suppliedIds) !== JSON.stringify(expectedIds)
  )
    fail("manifest artifact inventory is incomplete, duplicated, or extra");
  const proofById = new Map(
    proof.packages.map((record) => [record.artifactId, record])
  );
  const manifestById = new Map(
    manifest.artifacts.map((record) => [record.artifactId, record])
  );
  const expectedFiles = new Set(["hashes.json"]);
  for (const contractRecord of packageContract.packages) {
    const record = manifestById.get(contractRecord.id);
    const evidence = proofById.get(contractRecord.id);
    if (
      !record ||
      !evidence ||
      record.package !== contractRecord.package ||
      record.version !== contractRecord.version ||
      record.filename !== evidence.filename ||
      record.sha256 !== evidence.sha256 ||
      record.integrity !== evidence.integrity ||
      record.size !== evidence.size ||
      record.fileCount !== evidence.fileCount ||
      record.filesSha256 !== evidence.filesSha256 ||
      !/^[0-9a-f]{64}$/.test(record.metadataSha256) ||
      path.basename(record.filename) !== record.filename
    )
      fail(`${contractRecord.id}: metadata differs from P01 evidence`);
    expectedFiles.add(record.filename);
    const archive = path.join(directory, record.filename);
    if (
      !existsSync(archive) ||
      !lstatSync(archive).isFile() ||
      lstatSync(archive).isSymbolicLink()
    )
      fail(`${contractRecord.id}: archive is missing or linked`);
    if (
      sha256File(archive) !== record.sha256 ||
      statSync(archive).size !== record.size
    )
      fail(`${contractRecord.id}: archive bytes differ`);
    const localArchive = path.join(
      root,
      path.posix.dirname(contractRecord.manifest),
      packageContract.artifactPolicy.directory,
      record.filename
    );
    if (existsSync(localArchive)) {
      const inputInfo = statSync(archive);
      const localInfo = statSync(localArchive);
      if (inputInfo.dev === localInfo.dev && inputInfo.ino === localInfo.ino)
        fail(
          `${contractRecord.id}: archive is hard linked to repository output`
        );
    }
  }
  const actualFiles = readdirSync(directory).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify([...expectedFiles].sort()))
    fail("input contains missing or unexpected files");
  const selectedIds = options.selectedIds ?? expectedIds;
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !manifestById.has(id))
  )
    fail("selected artifact ids are duplicated or unknown");
  return selectedIds.map((id) => ({
    ...manifestById.get(id),
    path: path.join(directory, manifestById.get(id).filename),
  }));
}
