#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const digest = (contents) => createHash('sha256').update(contents).digest('hex');
const sha256 = (path) => digest(readFileSync(join(root, path)));
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
const n01Commit = 'a83234469609a7a037c67977d4d980fb5d602ab9';
const n02Commit = 'cc76293fb28f85f272bb898cc12de66ce4d5c416';
const expectedEvidenceSha256 = 'e1bd63c1cdb1190ae5aee88b6b1c5c5f660c5b965d5e5df63aad5acbbfef72ff';
const expectedClassificationSha256 = '9f7e4ea667a23c673ada140741831d8c26b55d7b66b22d4d2db69bcfe1cec359';
const expectedPathRepairsSha256 = '6925035749cb2a2efceec041e2489fbe516d56c05b44f9b75794941f5b3fbf3d';
const expectedSmokeLog = `runtime node=v24.19.0 npm=11.17.0
install=passed
workspace-query count=26
local-published-links count=12
root-lock=absent
core-compile=passed
react-package-build=passed
react-animating-build=passed
react-typescript-webpack=passed
redux-react-build=passed
`;
const expectedNonManifestChanges = [
  'README.md',
  'frameworks/react/examples/typescript/index.tsx',
  'frameworks/react/examples/typescript/tsconfig.json',
  'frameworks/react/examples/typescript/webpack.config.js',
  'migration/evidence/n02/install-smoke.log',
  'migration/evidence/n02/manifest-normalization.json',
  'migration/package-classification.json',
  'migration/path-repairs.json',
  'package.json',
  'tools/verify-manifest-normalization.mjs',
];
const gitArgs = ['-c', `safe.directory=${root}`, '-C', root];
const git = (...args) => execFileSync('git', [...gitArgs, ...args], { encoding: 'utf8' });
const gitBytes = (revision, path) => execFileSync('git', [...gitArgs, 'show', `${revision}:${path}`]);

requireEqual('N02 evidence base commit', evidence.baseCommit, n01Commit);
try {
  requireEqual('N01 baseline object', git('rev-parse', `${n01Commit}^{commit}`).trim(), n01Commit);
  requireEqual('N02 approved object', git('rev-parse', `${n02Commit}^{commit}`).trim(), n02Commit);
  execFileSync('git', [...gitArgs, 'merge-base', '--is-ancestor', n01Commit, n02Commit]);
  execFileSync('git', [...gitArgs, 'merge-base', '--is-ancestor', n02Commit, 'HEAD']);
} catch (error) {
  fail(`N01/N02 approved history must be available and ancestral to HEAD: ${error.message}`);
}
requireEqual(
  'N01 package-classification digest',
  evidence.packageClassificationBeforeSha256,
  digest(gitBytes(n01Commit, 'migration/package-classification.json')),
);
requireEqual('approved N02 evidence digest', digest(gitBytes(n02Commit, evidencePath)), expectedEvidenceSha256);
requireEqual('current N02 evidence digest', sha256(evidencePath), expectedEvidenceSha256);
requireEqual('approved N02 classification digest', digest(gitBytes(n02Commit, 'migration/package-classification.json')), expectedClassificationSha256);
requireEqual('approved N02 path-repair digest', digest(gitBytes(n02Commit, 'migration/path-repairs.json')), expectedPathRepairsSha256);
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
requireEqual('published classification count', classification.manifests.filter((record) => record.published).length, 12);
requireEqual('private classification count', classification.manifests.filter((record) => record.private).length, 32);
requireEqual('resolution-policy record count', classification.resolutions.length, 7);
requireEqual('local-tarball edge count', classification.edges.filter((edge) => edge.resolutionMode === 'local-tarball').length, 37);

const changedPaths = git('diff', '--name-only', n01Commit, n02Commit)
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort();
const expectedChangedPaths = [...classifiedPaths, ...expectedNonManifestChanges].sort();
requireEqual('N02 changed-file closure', changedPaths, expectedChangedPaths);

const toolchainAdjustments = new Map(evidence.exampleToolchainAdjustments.map((record) => [record.path, record]));
requireEqual('current-example toolchain adjustment count', toolchainAdjustments.size, 7);
const manifestHashes = new Map(evidence.manifestHashes.map((record) => [record.id, record]));
requireEqual('manifest-hash evidence count', manifestHashes.size, classification.inventoryManifestCount);

const removeField = (value, dottedField) => {
  const separator = dottedField.indexOf('.');
  if (separator === -1) {
    delete value[dottedField];
    return;
  }
  const section = dottedField.slice(0, separator);
  const name = dottedField.slice(separator + 1);
  if (value[section] && typeof value[section] === 'object') delete value[section][name];
};

const names = new Map([[rootPackage.name, 'package.json']]);
for (const record of classification.manifests) {
  const path = movePath(record.path);
  const manifest = readJson(path);
  const baselineBytes = gitBytes(n01Commit, path);
  const baseline = JSON.parse(baselineBytes.toString('utf8'));
  const approvedN02 = JSON.parse(gitBytes(n02Commit, path).toString('utf8'));
  const hashes = manifestHashes.get(record.id);
  if (!hashes) fail(`missing manifest-hash evidence: ${record.id}`);
  requireEqual(`${record.id} hash path`, hashes.path, path);
  requireEqual(`${record.id} baseline hash`, hashes.beforeSha256, digest(baselineBytes));
  requireEqual(`${record.id} approved N02 hash`, hashes.afterSha256, digest(gitBytes(n02Commit, path)));

  requireEqual(`${record.id} name`, manifest.name, record.finalName);
  requireEqual(`${record.id} private`, manifest.private === true, record.private);
  if (names.has(manifest.name)) fail(`duplicate package name ${manifest.name}: ${names.get(manifest.name)} and ${path}`);
  names.set(manifest.name, path);

  const allowedFields = new Set(record.published ? ['repository', 'bugs', 'homepage'] : ['name', 'private']);
  for (const edge of classification.edges) {
    if (edge.resolutionMode === 'workspace' && edge.declaredSpec !== null && movePath(edge.consumerManifest) === path) {
      allowedFields.add(`${edge.manifestSection}.${edge.package}`);
    }
  }
  for (const field of toolchainAdjustments.get(path)?.fields ?? []) allowedFields.add(field.field);
  if (['core/package.json', 'frameworks/angular-hybrid/uirouter-angular-hybrid/package.json', 'tools/publish-scripts/package.json'].includes(path)) {
    allowedFields.add('resolutions');
  }
  if (path === 'frameworks/angular/examples/sample-app/package.json') allowedFields.add('overrides');
  const baselineUnchanged = structuredClone(baseline);
  const approvedUnchanged = structuredClone(approvedN02);
  for (const field of allowedFields) {
    removeField(baselineUnchanged, field);
    removeField(approvedUnchanged, field);
  }
  requireEqual(`${record.id} approved fields outside N02 ownership`, approvedUnchanged, baselineUnchanged);
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
requireEqual('normalized workspace-edge count', workspaceEdges, 86);

const publishedEvidence = new Map(evidence.publishedPackages.map((record) => [record.id, record]));
requireEqual('published evidence count', publishedEvidence.size, 12);
for (const record of classification.manifests.filter((record) => record.published)) {
  const path = movePath(record.path);
  const manifest = JSON.parse(gitBytes(n02Commit, path).toString('utf8'));
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
  const manifest = JSON.parse(gitBytes(n02Commit, adjustment.path).toString('utf8'));
  for (const field of adjustment.fields) {
    const separator = field.field.indexOf('.');
    const section = field.field.slice(0, separator);
    const name = field.field.slice(separator + 1);
    requireEqual(`${adjustment.path} ${field.field}`, manifest[section]?.[name], field.after);
  }
}
requireEqual('configuration adjustment count', evidence.configurationAdjustments.length, 3);
for (const adjustment of evidence.configurationAdjustments) {
  requireEqual(`${adjustment.path} baseline hash`, adjustment.beforeSha256, digest(gitBytes(n01Commit, adjustment.path)));
  requireEqual(`${adjustment.path} approved N02 hash`, adjustment.afterSha256, digest(gitBytes(n02Commit, adjustment.path)));
}

const expectedResolutionIds = classification.resolutions.map((record) => record.id);
requireEqual('N03 deferred resolution task', evidence.deferredPolicy.resolutionTranslation.task, 'N03');
requireEqual('N03 deferred resolution records', evidence.deferredPolicy.resolutionTranslation.recordIds, expectedResolutionIds);
requireEqual('N05 deferred package-manager task', evidence.deferredPolicy.packageManagerCleanup.task, 'N05');
const nestedPackageManagers = [...classifiedPaths]
  .filter((path) => Object.hasOwn(JSON.parse(gitBytes(n02Commit, path).toString('utf8')), 'packageManager'))
  .sort();
requireEqual('N05 deferred package-manager paths', evidence.deferredPolicy.packageManagerCleanup.paths, nestedPackageManagers);
requireEqual('I01 deferred local-tarball task', evidence.deferredPolicy.localTarballEdges.task, 'I01');
requireEqual(
  'I01 deferred local-tarball edges',
  evidence.deferredPolicy.localTarballEdges.edgeIds,
  classification.edges.filter((edge) => edge.resolutionMode === 'local-tarball').map((edge) => edge.id),
);

requireEqual('install-smoke runtime image digest', evidence.installSmoke.runtimeImageDigest, 'sha256:56ab6ddaab798f0664b18448a1226bfa9e43aefaa90af280ff79d05c350a2ef8');
requireEqual('install-smoke workspace count', evidence.installSmoke.workspaceCount, 26);
requireEqual('install-smoke linked package count', evidence.installSmoke.linkedPublishedPackageCount, 12);
requireEqual('install-smoke root lock', evidence.installSmoke.rootLockPresent, false);
requireEqual('install-smoke log path', evidence.installSmoke.log.path, 'migration/evidence/n02/install-smoke.log');
requireEqual('install-smoke log digest', evidence.installSmoke.log.sha256, 'fa762a026e620246b152085e8f388dc750121afbf9524722dfef8ebed8a6ceee');
requireEqual('install-smoke log bytes', readText(evidence.installSmoke.log.path), expectedSmokeLog);

if (git('ls-tree', '-r', '--name-only', n02Commit, '--', 'package-lock.json').trim()) {
  fail('approved N02 commit unexpectedly contains a root package-lock.json');
}
console.log(`MANIFEST_NORMALIZATION_OK manifests=${classification.manifests.length} private=${classification.manifests.filter((record) => record.private).length} published=${publishedEvidence.size} workspaceEdges=${workspaceEdges}`);
