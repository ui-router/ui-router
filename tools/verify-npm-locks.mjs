#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readText = (path) => readFileSync(join(root, path), 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const digest = (contents) => createHash('sha256').update(contents).digest('hex');
const sha256 = (path) => digest(readFileSync(join(root, path)));
const stable = (value) => JSON.stringify(value ?? null);
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};
const requireEqual = (label, actual, expected) => {
  if (stable(actual) !== stable(expected)) fail(`${label}: expected ${stable(expected)}, got ${stable(actual)}`);
};

const classification = readJson('migration/package-classification.json');
const pathRepairs = readJson('migration/path-repairs.json');
const evidencePath = 'migration/evidence/n03/lock-conversion.json';
const evidence = readJson(evidencePath);
const expectedEvidenceSha256 = 'd0da15bae66357729e19dc18d38a6cef44a6314f29768f196a29f283e637f741';
const expectedClassificationSha256 = '52b1d3cc7b09ec98009cc4e5ed52d4fe200c84eec73904379fc14ff823b66c6d';
const expectedPathRepairsSha256 = 'a5d93abfcfe26da7742b16760c4c0cc9b2416e6b1ceb5cfbe58e58cdd59f4f49';
const expectedWorkspaces = [
  'core',
  'plugins/*',
  'plugins/*/examples/*',
  'frameworks/*/uirouter-*',
  'frameworks/*/examples/*',
  'tools/*',
];
const templateIds = [
  'framework/angular/integration/typescript-versions/scaffold',
  'framework/angularjs/integration/typescript-versions/template',
];

const movePath = (input) => {
  let output = input;
  for (const move of pathRepairs.moves) {
    if (output === move.from || output.startsWith(`${move.from}/`)) {
      output = `${move.to}${output.slice(move.from.length)}`;
    }
  }
  return output;
};

requireEqual('N03 task', evidence.task, 'N03');
requireEqual('N03 base', evidence.baseCommit, 'ce1cbb52907c66123f9c454082889f79a1e689a4');
const gitArgs = ['-c', `safe.directory=${root}`, '-C', root];
try {
  requireEqual('N03 base object', execFileSync('git', [...gitArgs, 'rev-parse', `${evidence.baseCommit}^{commit}`], { encoding: 'utf8' }).trim(), evidence.baseCommit);
  execFileSync('git', [...gitArgs, 'merge-base', '--is-ancestor', evidence.baseCommit, 'HEAD']);
} catch (error) {
  fail(`N03 base must be available and ancestral to HEAD: ${error.message}`);
}
requireEqual('runtime Node', evidence.runtime.node, 'v24.19.0');
requireEqual('runtime npm', evidence.runtime.npm, '11.17.0');
requireEqual('lifecycle execution', evidence.installPolicy.lifecycleScriptsExecuted, false);
requireEqual('approved N03 evidence digest', sha256(evidencePath), expectedEvidenceSha256);
requireEqual('approved N03 classification digest', sha256('migration/package-classification.json'), expectedClassificationSha256);
requireEqual('approved N03 path-repair digest', sha256('migration/path-repairs.json'), expectedPathRepairsSha256);
requireEqual('classification digest', pathRepairs.packageClassificationSha256, expectedClassificationSha256);
requireEqual('N03 evidence reference count', classification.resolutions.filter((record) => record.evidence?.path === evidencePath).length, 7);
const changedPaths = execFileSync('git', [...gitArgs, 'diff', '--no-renames', '--name-only', evidence.baseCommit, 'HEAD'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .sort();
const proofPaths = Object.values(evidence.proof).map((proof) => proof.path);
const expectedChangedPaths = [...new Set([
  ...evidence.removedCurrentLocks,
  evidence.rootLock.path,
  ...evidence.localLocks.map((record) => record.lock),
  evidencePath,
  ...proofPaths,
  'core/package.json',
  'frameworks/angular/examples/sample-app/package.json',
  'frameworks/angular-hybrid/uirouter-angular-hybrid/package.json',
  'tools/publish-scripts/package.json',
  'migration/package-classification.json',
  'migration/path-repairs.json',
  'package.json',
  'tools/verify-manifest-normalization.mjs',
  'tools/verify-npm-locks.mjs',
  'tools/verify-root-config.mjs',
])].sort();
requireEqual('N03 changed-file closure', changedPaths, expectedChangedPaths);
for (const record of classification.resolutions) {
  requireEqual(`${record.id} evidence digest`, record.evidence, { path: evidencePath, sha256: sha256(evidencePath) });
  requireEqual(`${record.id} root scope`, record.rootScopeBroadens, false);
}
for (const id of templateIds) {
  const record = classification.manifests.find((candidate) => candidate.id === id);
  if (!record) fail(`missing template classification: ${id}`);
  requireEqual(`${id} lock owner`, record.lockOwner, 'none');
  requireEqual(`${id} resolution mode`, record.internalResolutionMode, 'none');
  requireEqual(`${id} evidence`, record.evidence, { path: evidencePath, sha256: sha256(evidencePath) });
}

const ignored = new Set(['.git', '.migration-work', 'archive', 'node_modules']);
const discoveredLocks = [];
const forbiddenLocks = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const absolute = join(directory, entry);
    const info = lstatSync(absolute);
    if (info.isDirectory()) walk(absolute);
    else {
      const path = relative(root, absolute).split(sep).join('/');
      if (entry === 'package-lock.json') discoveredLocks.push(path);
      if (entry === 'yarn.lock' || entry === 'pnpm-lock.yaml') forbiddenLocks.push(path);
    }
  }
};
walk(root);
requireEqual('current Yarn/pnpm locks', forbiddenLocks, []);

const rootOwned = classification.manifests.filter((record) => record.lockOwner === 'root');
const localOwned = classification.manifests.filter((record) => record.lockOwner === 'local');
requireEqual('root-owned manifest count', rootOwned.length, 26);
requireEqual('local-owned manifest count', localOwned.length, 14);
const expectedLocks = [
  'package-lock.json',
  ...localOwned.map((record) => `${dirname(movePath(record.path))}/package-lock.json`),
].sort();
requireEqual('npm lock placement', discoveredLocks.sort(), expectedLocks);

const rootLock = readJson('package-lock.json');
requireEqual('root lockfile version', rootLock.lockfileVersion, 3);
requireEqual('root lock workspace globs', rootLock.packages[''].workspaces, expectedWorkspaces);
requireEqual('root lock digest', evidence.rootLock.sha256, sha256('package-lock.json'));
requireEqual('root lock package count', evidence.rootLock.packageEntries, Object.keys(rootLock.packages).length);
requireEqual('root lock workspace count', evidence.rootLock.workspaceCount, rootOwned.length);

const published = new Map();
for (const record of classification.manifests.filter((record) => record.published)) {
  const manifestPath = movePath(record.path);
  const manifest = readJson(manifestPath);
  published.set(manifest.name, { path: dirname(manifestPath), version: manifest.version });
}
requireEqual('published package count', published.size, 12);
for (const record of rootOwned) {
  const manifestPath = movePath(record.path);
  const manifest = readJson(manifestPath);
  const link = rootLock.packages[`node_modules/${manifest.name}`];
  if (!link?.link) fail(`root lock is missing workspace link for ${manifest.name}`);
  requireEqual(`${manifest.name} workspace link`, link.resolved, dirname(manifestPath));
}

let workspaceEdges = 0;
for (const edge of classification.edges) {
  if (edge.resolutionMode !== 'workspace' || edge.declaredSpec === null) continue;
  const manifestPath = movePath(edge.consumerManifest);
  const manifest = readJson(manifestPath);
  requireEqual(`${edge.id} manifest spec`, manifest[edge.manifestSection]?.[edge.package], edge.finalSpec);
  const target = published.get(edge.package);
  if (!target) fail(`${edge.id} targets a non-published workspace package: ${edge.package}`);
  requireEqual(`${edge.id} version`, target.version, edge.expectedVersion);
  const link = rootLock.packages[`node_modules/${edge.package}`];
  if (!link?.link) fail(`${edge.id} does not use a root workspace link`);
  requireEqual(`${edge.id} lock origin`, link.resolved, target.path);
  workspaceEdges += 1;
}
requireEqual('workspace edge count', workspaceEdges, 86);
requireEqual('workspace proof count', evidence.proof.workspaceResolution.edgeCount, workspaceEdges);
requireEqual('workspace proof digest', evidence.proof.workspaceResolution.sha256, sha256(evidence.proof.workspaceResolution.path));

const localEvidence = new Map(evidence.localLocks.map((record) => [record.manifest, record]));
requireEqual('local lock evidence count', localEvidence.size, localOwned.length);
let committedLocalEdges = 0;
for (const record of localOwned) {
  const manifestPath = movePath(record.path);
  const lockPath = `${dirname(manifestPath)}/package-lock.json`;
  const manifest = readJson(manifestPath);
  const lock = readJson(lockPath);
  const proof = localEvidence.get(manifestPath);
  if (!proof) fail(`missing local lock evidence: ${manifestPath}`);
  requireEqual(`${record.id} evidence lock`, proof.lock, lockPath);
  requireEqual(`${record.id} evidence digest`, proof.sha256, sha256(lockPath));
  requireEqual(`${record.id} lockfile version`, lock.lockfileVersion, 3);
  requireEqual(`${record.id} lock root name`, lock.packages[''].name, manifest.name);
  requireEqual(`${record.id} lock root version`, lock.packages[''].version, manifest.version);
  for (const edge of classification.edges) {
    if (movePath(edge.consumerManifest) !== manifestPath || edge.resolutionMode !== 'local-tarball' || edge.declaredSpec === null) continue;
    const entry = lock.packages[`node_modules/${edge.package}`];
    if (!entry || entry.link) fail(`${edge.id} committed fixture lock is missing its registry baseline`);
    requireEqual(`${edge.id} registry baseline version`, entry.version, edge.expectedVersion);
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/')) fail(`${edge.id} has a non-registry committed baseline: ${entry.resolved}`);
    committedLocalEdges += 1;
  }
}
requireEqual('committed local edge count', committedLocalEdges, evidence.deferredPackedProof.declaredCommittedEdges);
requireEqual('deferred packed task', evidence.deferredPackedProof.task, 'I02');
requireEqual('classified local-tarball edge count', evidence.deferredPackedProof.localTarballEdges, 37);
requireEqual('legacy-injected edge count', evidence.deferredPackedProof.legacyInjectedEdges, 14);
requireEqual('template blueprint edge count', evidence.deferredPackedProof.templateBlueprintEdges, 2);

const allManifests = classification.manifests.map((record) => movePath(record.path));
const manifestsWithResolutions = allManifests.filter((path) => Object.hasOwn(readJson(path), 'resolutions'));
requireEqual('remaining Yarn resolutions', manifestsWithResolutions, []);
requireEqual('root resolutions', readJson('package.json').resolutions, undefined);
requireEqual('root overrides', readJson('package.json').overrides, undefined);
const overrideOwners = allManifests.filter((path) => Object.hasOwn(readJson(path), 'overrides')).sort();
requireEqual('scoped npm override owners', overrideOwners, [
  'frameworks/angular/integration-tests/angular-versions/v22-standalone/package.json',
  'frameworks/angular/integration-tests/angular-versions/v22-zoneless/package.json',
  'frameworks/angular/integration-tests/angular-versions/v22/package.json',
]);
for (const path of overrideOwners) {
  requireEqual(`${path} override`, readJson(path).overrides, {
    '@uirouter/angular': {
      '@angular/common': '$@angular/common',
      '@angular/core': '$@angular/core',
    },
  });
}

for (const key of ['rootInstall', 'localInstall', 'npmLsProblems', 'npmLsInternal']) {
  const proof = evidence.proof[key];
  requireEqual(`${key} digest`, proof.sha256, sha256(proof.path));
}
const npmLsInternal = readJson(evidence.proof.npmLsInternal.path);
requireEqual('root npm ls internal count', npmLsInternal.packageCount, 12);
requireEqual('root npm ls internal evidence count', evidence.proof.npmLsInternal.packageCount, 12);
const npmLsInternalByName = new Map(npmLsInternal.packages.map((record) => [record.package, record]));
for (const [name, target] of published) {
  const record = npmLsInternalByName.get(name);
  if (!record) fail(`root npm ls proof is missing ${name}`);
  requireEqual(`${name} npm ls version`, record.version, target.version);
  requireEqual(`${name} npm ls workspace`, record.workspacePath, target.path);
  requireEqual(`${name} npm ls invalid`, record.invalid, false);
  requireEqual(`${name} npm ls overridden`, record.overridden, false);
  if (!record.npmLsResolved?.startsWith('file:')) fail(`${name} npm ls origin is not a workspace file link: ${record.npmLsResolved}`);
}
const npmLsProblems = readJson(evidence.proof.npmLsProblems.path);
requireEqual('root npm ls status', npmLsProblems.exitStatus, 1);
requireEqual('root npm ls problem count', npmLsProblems.problemCount, 15);
requireEqual('root npm ls disposition', npmLsProblems.disposition, {
  status: 'waived-failure',
  owner: 'ui-router-maintainers',
  trackingTask: 'S01',
  expiresOn: '2026-09-30',
  reason: 'The first combined root graph exposes pre-existing cross-source dev-tool and peer-range conflicts; all classified internal workspace edges independently resolve to their local package and S01 owns toolchain convergence.',
});

const installedFlag = process.argv.indexOf('--installed-root');
if (installedFlag !== -1) {
  const installedRoot = resolve(process.argv[installedFlag + 1] ?? '');
  if (!existsSync(installedRoot)) fail(`installed root does not exist: ${installedRoot}`);
  const findInstalledPackage = (consumerDirectory, packageName) => {
    let directory = resolve(installedRoot, consumerDirectory);
    while (true) {
      const candidate = join(directory, 'node_modules', ...packageName.split('/'));
      if (existsSync(candidate)) return realpathSync(candidate);
      if (directory === installedRoot) return null;
      const parent = dirname(directory);
      if (!parent.startsWith(installedRoot)) return null;
      directory = parent;
    }
  };
  for (const edge of classification.edges) {
    if (edge.resolutionMode !== 'workspace' || edge.declaredSpec === null) continue;
    const consumerPath = movePath(edge.consumerManifest);
    const target = published.get(edge.package);
    const actual = findInstalledPackage(dirname(consumerPath), edge.package);
    const expected = realpathSync(join(installedRoot, target.path));
    requireEqual(`${edge.id} installed realpath`, actual, expected);
    const installedManifest = JSON.parse(readFileSync(join(actual, 'package.json'), 'utf8'));
    requireEqual(`${edge.id} installed name`, installedManifest.name, edge.package);
    requireEqual(`${edge.id} installed version`, installedManifest.version, edge.expectedVersion);
  }
}

if (existsSync(join(root, 'node_modules'))) {
  fail('repository checkout contains node_modules; run installed-origin proof against a disposable copy with --installed-root');
}
console.log(`NPM_LOCKS_OK root=1 local=${localOwned.length} workspaces=${rootOwned.length} workspaceEdges=${workspaceEdges} registryBaselineEdges=${committedLocalEdges}`);
