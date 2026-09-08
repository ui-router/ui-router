import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

const baselinePath = "migration/evidence/n03/root-npm-ls-problems.json";
const resolutionPath = "migration/evidence/p01/npm-ls-resolutions.json";
const ignoredDirectories = new Set([
  ".git",
  ".migration-work",
  "_bundles",
  "dist",
  "lib",
  "lib-esm",
  "node_modules",
]);

function fail(message) {
  throw new Error(`CURRENT_NPM_LS_POLICY_FAILED: ${message}`);
}

function readJson(repository, relative) {
  return JSON.parse(readFileSync(path.join(repository, relative), "utf8"));
}

function sha256File(repository, relative) {
  return createHash("sha256")
    .update(readFileSync(path.join(repository, relative)))
    .digest("hex");
}

function safeRelative(relative, label) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative === "" ||
    relative.split(/[\\/]/).includes("..")
  )
    fail(`${label} is not a safe repository-relative path`);
}

export function activePackageManifests(repository) {
  const canonicalRepository = realpathSync(repository);
  const manifests = [];
  function walk(absolute, relative = "") {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const child = path.join(absolute, entry.name);
      const childRelative = path.posix.join(relative, entry.name);
      const info = lstatSync(child);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(child, childRelative);
      else if (info.isFile() && entry.name === "package.json")
        manifests.push(childRelative);
    }
  }
  walk(canonicalRepository);
  return manifests.sort();
}

export function loadCurrentNpmLsPolicy(repository) {
  const canonicalRepository = realpathSync(repository);
  const baseline = readJson(canonicalRepository, baselinePath);
  const policy = readJson(canonicalRepository, resolutionPath);

  if (
    policy.schemaVersion !== 1 ||
    policy.task !== "P01" ||
    policy.baseline?.path !== baselinePath ||
    policy.baseline?.sha256 !== sha256File(canonicalRepository, baselinePath) ||
    policy.baseline?.problemCount !== baseline.problemCount ||
    baseline.problemCount !== baseline.problems?.length
  )
    fail("resolution record is not bound to the reviewed N03 baseline");
  if (!Array.isArray(policy.resolved) || policy.resolved.length === 0)
    fail("resolution record has no resolved problems");

  const manifests = activePackageManifests(canonicalRepository);
  const resolvedProblems = new Set();
  const resolvedDependencies = new Set();
  for (const resolution of policy.resolved) {
    if (
      typeof resolution.problem !== "string" ||
      !baseline.problems.includes(resolution.problem)
    )
      fail(`resolution names an unknown problem: ${resolution.problem}`);
    if (resolvedProblems.has(resolution.problem))
      fail(`problem is resolved more than once: ${resolution.problem}`);
    resolvedProblems.add(resolution.problem);

    if (
      typeof resolution.dependency !== "string" ||
      !resolution.problem.startsWith(`invalid: ${resolution.dependency}@`) ||
      resolution.dependencyType !== "devDependencies" ||
      typeof resolution.requiredRange !== "string" ||
      typeof resolution.reason !== "string" ||
      resolution.reason.trim() === ""
    )
      fail(`resolution metadata is incomplete for ${resolution.problem}`);
    if (resolvedDependencies.has(resolution.dependency))
      fail(`dependency is resolved more than once: ${resolution.dependency}`);
    resolvedDependencies.add(resolution.dependency);

    if (!Array.isArray(resolution.manifests) || resolution.manifests.length === 0)
      fail(`resolution has no manifest inventory for ${resolution.dependency}`);
    const declaredManifests = [...new Set(resolution.manifests)].sort();
    if (declaredManifests.length !== resolution.manifests.length)
      fail(`resolution repeats a manifest for ${resolution.dependency}`);
    for (const manifestPath of declaredManifests)
      safeRelative(manifestPath, `${resolution.dependency} manifest`);

    const actualManifests = manifests.filter((manifestPath) => {
      const manifest = readJson(canonicalRepository, manifestPath);
      return resolution.dependency in (manifest[resolution.dependencyType] ?? {});
    });
    if (JSON.stringify(actualManifests) !== JSON.stringify(declaredManifests))
      fail(`active manifest inventory differs for ${resolution.dependency}`);
    for (const manifestPath of actualManifests) {
      const manifest = readJson(canonicalRepository, manifestPath);
      if (
        manifest[resolution.dependencyType][resolution.dependency] !==
        resolution.requiredRange
      )
        fail(`${manifestPath} does not prove the ${resolution.dependency} resolution`);
    }
  }

  const expectedProblems = baseline.problems.filter(
    (problem) => !resolvedProblems.has(problem)
  );
  if (expectedProblems.length !== policy.currentProblemCount)
    fail("current problem count does not match the explicit resolutions");

  return {
    baselineProblemCount: baseline.problemCount,
    currentProblemCount: expectedProblems.length,
    expectedExitStatus: expectedProblems.length === 0 ? 0 : baseline.exitStatus,
    expectedProblems,
    resolvedProblemCount: resolvedProblems.size,
    verifiedManifestCount: policy.resolved.reduce(
      (count, resolution) => count + resolution.manifests.length,
      0
    ),
  };
}
