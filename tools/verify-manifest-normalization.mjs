#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const sha256 = (path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};
const stable = (value) => JSON.stringify(value ?? null);
const requireEqual = (label, actual, expected) => {
  if (stable(actual) !== stable(expected)) fail(`${label}: expected ${stable(expected)}, got ${stable(actual)}`);
};

const npmRoot = execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim();
const require = createRequire(import.meta.url);
const semver = require(join(npmRoot, 'npm/node_modules/semver'));
const rootPackage = readJson('package.json');
const classification = readJson('migration/package-classification.json');
const pathRepairs = readJson('migration/path-repairs.json');
const evidencePath = 'migration/evidence/n02/manifest-normalization.json';
const evidence = readJson(evidencePath);

requireEqual('path-repair classification digest', pathRepairs.packageClassificationSha256, sha256('migration/package-classification.json'));
requireEqual('N02 evidence task', evidence.task, 'N02');
requireEqual('N02 evidence execution-lock digest', evidence.executionLockSha256, classification.executionLockSha256);
requireEqual('N02 evidence baseline digest', evidence.baselinesSha256, classification.baselinesSha256);

const movePath = (input) => {
  let output = input;
  for (const move of pathRepairs.moves) {
    if (output === move.from || output.startsWith(`${move.from}/`)) {
      output = `${move.to}${output.slice(move.from.length)}`;
    }
  }
  return output;
};

const ignoredDirectories = new Set(['.git', '.migration-work', 'archive', 'node_modules']);
const packageFiles = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;
    const absolute = join(directory, entry);
    const info = statSync(absolute);
    if (info.isDirectory()) walk(absolute);
    else if (entry === 'package.json') packageFiles.push(relative(root, absolute).split(sep).join('/'));
  }
};
walk(root);

const classifiedPaths = new Set(classification.manifests.map((record) => movePath(record.path)));
const importedPaths = new Set(packageFiles.filter((path) => path !== 'package.json'));
requireEqual('classified manifest count', classifiedPaths.size, classification.inventoryManifestCount);
requireEqual('discovered imported manifest count', importedPaths.size, classification.inventoryManifestCount);
for (const path of classifiedPaths) if (!importedPaths.has(path)) fail(`classified manifest is missing: ${path}`);
for (const path of importedPaths) if (!classifiedPaths.has(path)) fail(`manifest is unclassified: ${path}`);

const names = new Map([[rootPackage.name, 'package.json']]);
for (const record of classification.manifests) {
  const path = movePath(record.path);
  const manifest = readJson(path);
  requireEqual(`${record.id} name`, manifest.name, record.finalName);
  requireEqual(`${record.id} private`, manifest.private === true, record.private);
  if (names.has(manifest.name)) fail(`duplicate package name ${manifest.name}: ${names.get(manifest.name)} and ${path}`);
  names.set(manifest.name, path);
}

let workspaceEdges = 0;
for (const edge of classification.edges) {
  if (edge.resolutionMode !== 'workspace' || edge.declaredSpec === null) continue;
  const path = movePath(edge.consumerManifest);
  const manifest = readJson(path);
  const actual = manifest[edge.manifestSection]?.[edge.package];
  requireEqual(`${edge.id} final spec`, actual, edge.finalSpec);
  if (!semver.validRange(actual) || !semver.satisfies(edge.expectedVersion, actual)) {
    fail(`${edge.id} does not admit local ${edge.expectedVersion}: ${actual}`);
  }
  if (actual.startsWith('file:') || actual.startsWith('workspace:')) {
    fail(`${edge.id} uses a non-publishable local spec: ${actual}`);
  }
  workspaceEdges += 1;
}

const publishedEvidence = new Map(evidence.publishedPackages.map((record) => [record.id, record]));
for (const record of classification.manifests.filter((record) => record.published)) {
  const path = movePath(record.path);
  const manifest = readJson(path);
  const expected = publishedEvidence.get(record.id);
  if (!expected) fail(`missing published-package evidence: ${record.id}`);
  requireEqual(`${record.id} evidence path`, expected.path, path);
  for (const field of ['name', 'version', 'engines', 'dependencies', 'peerDependencies', 'optionalDependencies']) {
    requireEqual(`${record.id} preserved ${field}`, manifest[field], expected.identityAndPublishedIntent[field]);
  }
  requireEqual(`${record.id} repository`, manifest.repository, expected.metadataTarget.repository);
  requireEqual(`${record.id} bugs`, manifest.bugs, expected.metadataTarget.bugs);
  requireEqual(`${record.id} homepage`, manifest.homepage, expected.metadataTarget.homepage);
}

const evidenceSha256 = sha256(evidencePath);
for (const adjustment of evidence.edgeAdjustments) {
  const edge = classification.edges.find((candidate) => candidate.id === adjustment.edgeId);
  if (!edge) fail(`N02 edge adjustment is missing from classification: ${adjustment.edgeId}`);
  requireEqual(`${adjustment.edgeId} adjusted final spec`, edge.finalSpec, adjustment.finalSpec);
  requireEqual(`${adjustment.edgeId} evidence path`, edge.evidence?.path, evidencePath);
  requireEqual(`${adjustment.edgeId} evidence digest`, edge.evidence?.sha256, evidenceSha256);
}
for (const adjustment of evidence.exampleToolchainAdjustments) {
  const manifest = readJson(adjustment.path);
  for (const field of adjustment.fields) {
    const separator = field.field.indexOf('.');
    const section = field.field.slice(0, separator);
    const name = field.field.slice(separator + 1);
    requireEqual(`${adjustment.path} ${field.field}`, manifest[section]?.[name], field.after);
  }
}
for (const adjustment of evidence.configurationAdjustments) {
  const contents = readText(adjustment.path);
  for (const change of adjustment.changes) {
    if (!contents.includes(change.after)) fail(`${adjustment.path} is missing ${change.field}: ${change.after}`);
    if (contents.includes(change.before)) fail(`${adjustment.path} retains stale ${change.field}: ${change.before}`);
  }
}
requireEqual('install-smoke runtime image digest', evidence.installSmoke.runtimeImageDigest, 'sha256:56ab6ddaab798f0664b18448a1226bfa9e43aefaa90af280ff79d05c350a2ef8');
requireEqual('install-smoke workspace count', evidence.installSmoke.workspaceCount, 26);
requireEqual('install-smoke linked package count', evidence.installSmoke.linkedPublishedPackageCount, publishedEvidence.size);
requireEqual('install-smoke root lock', evidence.installSmoke.rootLockPresent, false);
requireEqual('install-smoke log digest', evidence.installSmoke.log.sha256, sha256(evidence.installSmoke.log.path));

if (existsSync(join(root, 'package-lock.json'))) fail('root package-lock.json is forbidden until N03');
console.log(`MANIFEST_NORMALIZATION_OK manifests=${classification.manifests.length} private=${classification.manifests.filter((record) => record.private).length} published=${publishedEvidence.size} workspaceEdges=${workspaceEdges}`);
