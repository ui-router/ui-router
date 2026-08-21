import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertRepoPath, executionToolchain, fail, git, gitBlobBuffer, isObjectId, pathExists, readJson, run, sha256Buffer,
  sha256File, sha256Tree, validateLocalSourceMetadata, validateManifestImmutable,
} from './history-migration-lib.mjs';
import {
  CONTRACT_VALIDATOR_NAME, CONTRACT_VALIDATOR_VERSION, validateJsonSchema,
} from './validate-migration-contract.mjs';

const CONTROL_FILES = [
  ['sources', 'migration/sources.json'],
  ['execution-lock', 'migration/execution-lock.json'],
  ['baselines', 'migration/baselines.json'],
  ['package-classification', 'migration/package-classification.json'],
];
const CONTROL_EVIDENCE_PREFIX = 'migration/control-evidence/';
const IMPORTED_EVIDENCE_PREFIX = 'migration/evidence/control/';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be a SHA-256 digest`);
}

function assertUniqueBy(records, selector, label) {
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    const value = selector(record);
    if (seen.has(value)) fail(`${label} repeats ${value} at index ${index}`);
    seen.add(value);
  }
}

function pathWithin(root, candidate) {
  const relation = path.relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation));
}

function resolveUnder(root, relativePath, label) {
  assertRepoPath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  const relation = path.relative(resolvedRoot, resolved);
  if (relation === '' || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    fail(`${label} escapes its root: ${relativePath}`);
  }
  return resolved;
}

async function assertRealpathUnder(root, filename, label) {
  if ((await lstat(filename)).isSymbolicLink()) fail(`${label} must not be a symbolic link: ${filename}`);
  const [realRoot, realFilename] = await Promise.all([realpath(root), realpath(filename)]);
  const relation = path.relative(realRoot, realFilename);
  if (relation === '' || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    fail(`${label} resolves outside its root: ${filename}`);
  }
  return realFilename;
}

async function recursiveFiles(root, relative = '') {
  const directory = path.join(root, relative);
  if (!(await pathExists(directory))) return [];
  const files = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await recursiveFiles(root, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join('/'));
    else fail(`Control evidence contains a non-file entry: ${child}`);
  }
  return files;
}

function collectEvidence(value, ownerContract, records, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectEvidence(child, ownerContract, records, `${location}/${index}`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.evidence && typeof value.evidence.path === 'string' && typeof value.evidence.sha256 === 'string') {
    records.push({ ownerContract, ...value.evidence, location });
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'evidence') collectEvidence(child, ownerContract, records, `${location}/${key}`);
  }
}

function expectedSourceRefs(source) {
  return [source.sourceRef, ...source.releaseTags.map((tag) => tag.sourceRef), ...source.excludedTags.map((tag) => tag.sourceRef)].sort();
}

function compareToolchain(manifest, lock, observed) {
  const expected = {
    node: lock.toolchain.node,
    npm: lock.toolchain.npm,
    git: lock.toolchain.git,
    python: lock.toolchain.python,
    uv: lock.toolchain.uv,
    gitFilterRepoPackageVersion: lock.toolchain.gitFilterRepo.packageVersion,
    gitFilterRepoReportedVersion: lock.toolchain.gitFilterRepo.reportedVersion,
    gitFilterRepoExecutableSha256: lock.toolchain.gitFilterRepo.wrapperSha256,
  };
  if (canonicalJson(manifest.historyToolchain) !== canonicalJson(expected)) {
    fail('Source manifest historyToolchain differs from execution-lock toolchain');
  }
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    fail(`History toolchain mismatch:\nexpected ${JSON.stringify(expected)}\nobserved ${JSON.stringify(observed)}`);
  }
}

export function controlFileDefinitions() {
  return CONTROL_FILES.map(([id, filename]) => ({ id, filename }));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function expectedFilterRepoWrapper(wrapper, artifact, pythonExecutable) {
  const relativeArtifact = path.relative(path.dirname(wrapper), artifact).split(path.sep).join('/');
  return [
    '#!/bin/sh',
    'set -eu',
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    `ARTIFACT_RELATIVE=${shellQuote(relativeArtifact)}`,
    `exec ${shellQuote(pythonExecutable)} "$SCRIPT_DIR/$ARTIFACT_RELATIVE" "$@"`,
    '',
  ].join('\n');
}

async function inspectLockedFilterRepoArtifacts(artifactRoot, executionLock) {
  const descriptor = executionLock?.toolchain?.gitFilterRepo;
  if (!descriptor || typeof descriptor !== 'object') fail('Execution lock lacks gitFilterRepo metadata');
  const artifact = resolveUnder(artifactRoot, descriptor.artifactPath, 'git-filter-repo artifact path');
  const wrapper = resolveUnder(artifactRoot, descriptor.wrapperPath, 'git-filter-repo wrapper path');
  const pythonExecutable = executionLock?.toolchain?.pythonExecutable;
  const pythonDigest = executionLock?.toolchain?.pythonExecutableSha256;
  if (typeof pythonExecutable !== 'string' || !path.isAbsolute(pythonExecutable)) {
    fail('Execution lock lacks an absolute Python executable');
  }
  const pythonMetadata = await lstat(pythonExecutable);
  if (pythonMetadata.isSymbolicLink() || !pythonMetadata.isFile()) fail('Locked Python executable must be a regular file');
  if (await sha256File(pythonExecutable) !== pythonDigest) fail('Locked Python executable digest differs');
  for (const [label, filename, digest] of [
    ['git-filter-repo artifact', artifact, descriptor.artifactSha256],
    ['git-filter-repo wrapper', wrapper, descriptor.wrapperSha256],
  ]) {
    if (!(await pathExists(filename))) fail(`${label} is missing: ${filename}`);
    await assertRealpathUnder(artifactRoot, filename, label);
    if (await sha256File(filename) !== digest) fail(`${label} digest differs`);
  }
  const expectedWrapper = expectedFilterRepoWrapper(wrapper, artifact, pythonExecutable);
  if (await readFile(wrapper, 'utf8') !== expectedWrapper) {
    fail('git-filter-repo wrapper differs from the local-artifact-only policy');
  }
  return { artifact, descriptor, pythonExecutable, wrapper };
}

function lockedPythonEnvironment(pythonExecutable) {
  return {
    HOME: '/',
    LC_ALL: 'C',
    PATH: `${path.dirname(pythonExecutable)}:/usr/bin:/bin`,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONSAFEPATH: '1',
    TZ: 'UTC',
  };
}

export async function lockedFilterRepoDescriptor(artifactRoot, executionLock) {
  const inspected = await inspectLockedFilterRepoArtifacts(artifactRoot, executionLock);
  const pythonEnv = lockedPythonEnvironment(inspected.pythonExecutable);
  const pythonVersion = run(inspected.pythonExecutable, ['--version'], {
    cleanEnv: true,
    env: pythonEnv,
  }).stdout.trim();
  if (pythonVersion !== executionLock.toolchain.python) fail('Locked Python executable version differs');
  const observed = run(inspected.pythonExecutable, [inspected.artifact, '--version'], {
    cleanEnv: true,
    env: { ...pythonEnv, UIROUTER_DIRECT_ARTIFACT_PROBE: '1' },
  });
  return {
    command: inspected.wrapper,
    version: observed.stdout.trim(),
    executableSha256: inspected.descriptor.wrapperSha256,
  };
}

export function importedEvidencePath(sourcePath) {
  if (!sourcePath.startsWith(CONTROL_EVIDENCE_PREFIX)) fail(`Invalid control evidence path: ${sourcePath}`);
  return `${IMPORTED_EVIDENCE_PREFIX}${sourcePath.slice(CONTROL_EVIDENCE_PREFIX.length)}`;
}

async function inspectLockedValidator(artifactRoot, descriptor) {
  const filename = resolveUnder(artifactRoot, descriptor.artifactPath, 'contract schema validator path');
  if (!(await pathExists(filename))) fail(`Contract schema validator is missing: ${filename}`);
  await assertRealpathUnder(artifactRoot, filename, 'contract schema validator');
  if (await sha256File(filename) !== descriptor.artifactSha256) fail('contract schema validator digest differs');
  return filename;
}

async function loadLockedValidator(artifactRoot, descriptor) {
  const filename = await inspectLockedValidator(artifactRoot, descriptor);
  const module = await import(`${pathToFileURL(filename).href}?sha256=${descriptor.artifactSha256}`);
  if (module.CONTRACT_VALIDATOR_NAME !== CONTRACT_VALIDATOR_NAME
    || module.CONTRACT_VALIDATOR_VERSION !== CONTRACT_VALIDATOR_VERSION
    || typeof module.validateJsonSchema !== 'function') fail('Locked contract schema validator identity differs');
  return module.validateJsonSchema;
}

async function validateSchemaRoot(contractRoot, executionLock) {
  const schemaRoot = path.join(contractRoot, 'migration/schemas');
  const [realContractRoot, realSchemaRoot] = await Promise.all([realpath(contractRoot), realpath(schemaRoot)]);
  if (!pathWithin(realContractRoot, realSchemaRoot)) fail('Contract schema root resolves outside the contract root');
  if (await sha256Tree(schemaRoot) !== executionLock?.toolchain?.contractSchemaBundleSha256) {
    fail('Contract schema bundle digest differs');
  }
  await validateJsonSchema(executionLock, path.join(schemaRoot, 'execution-lock.schema.json'));
  return schemaRoot;
}

async function validateOfficialControlCheckout(artifactRoot, executionLock) {
  if (git(artifactRoot, ['merge-base', '--is-ancestor', executionLock.targetBase, 'HEAD'], {
    allowFailure: true,
  }).status !== 0) fail('Locked target base is not an ancestor of the control checkout');
  if (git(artifactRoot, ['rev-list', '--merges', `${executionLock.targetBase}..HEAD`]).stdout.trim() !== '') {
    fail('Control branch is not linear after the locked target base');
  }
  if (git(artifactRoot, [
    'status', '--porcelain', '--untracked-files=no', '--',
    'migration/sources.json', 'migration/execution-lock.json',
    'migration/baselines.json', 'migration/package-classification.json', 'migration/control-evidence',
  ]).stdout !== '') fail('Control contracts/evidence have tracked modifications');
  const changedPaths = git(artifactRoot, [
    'diff', '--name-only', `${executionLock.targetBase}..HEAD`,
  ]).stdout.split('\n').filter(Boolean);
  const allowedControlPaths = new Set(CONTROL_FILES.map(([, filename]) => filename));
  const unexpectedPath = changedPaths.find((filename) => (
    !allowedControlPaths.has(filename) && !filename.startsWith(CONTROL_EVIDENCE_PREFIX)
  ));
  if (unexpectedPath) fail(`Control branch changes a non-control path: ${unexpectedPath}`);
}

export async function validateExecutionLockPreflight({
  contractRoot, artifactRoot, manifest, executionLock, expectedBase, fixture = false,
  requireCommittedControl = false,
}) {
  await validateSchemaRoot(contractRoot, executionLock);
  if (!isObjectId(executionLock.targetBase)) fail('Execution lock targetBase is invalid');
  if (expectedBase && executionLock.targetBase !== expectedBase) fail('Execution lock targetBase differs from --base');
  if (executionLock.sourceManifestSha256 !== await sha256File(path.join(contractRoot, 'migration/sources.json'))) {
    fail('Execution lock sourceManifestSha256 differs from migration/sources.json');
  }
  await inspectLockedFilterRepoArtifacts(artifactRoot, executionLock);
  await inspectLockedValidator(artifactRoot, executionLock.toolchain.contractSchemaValidator);
}

export async function validateExecutionLockInputs({
  artifactRoot, manifest, executionLock, fixture = false, requireCommittedControl = false,
}) {
  const baseRepository = fixture ? fileURLToPath(manifest.target.url) : artifactRoot;
  const baseManifest = gitBlobBuffer(baseRepository, executionLock.targetBase, 'migration/sources.json');
  if (sha256Buffer(baseManifest) !== executionLock.targetBaseSourceManifestSha256) {
    fail('Locked target-base source manifest digest differs');
  }
  if (!fixture) validateManifestImmutable(manifest, JSON.parse(baseManifest.toString('utf8')));
  if (!fixture && requireCommittedControl) await validateOfficialControlCheckout(artifactRoot, executionLock);

  if (executionLock.sources.length !== manifest.sources.length) fail('Execution lock source count differs from manifest');
  if (!fixture && executionLock.sources.length !== 16) fail('Official execution lock must contain exactly 16 sources');
  assertUniqueBy(executionLock.sources, (source) => source.name, 'Execution lock sources');
  for (const [index, source] of manifest.sources.entries()) {
    const locked = executionLock.sources[index];
    if (locked.name !== source.name || locked.defaultHead !== source.defaultHead
      || locked.tagSnapshotSha256 !== source.tagSnapshotSha256) {
      fail(`Execution lock source facts differ at index ${index}`);
    }
    if (canonicalJson(locked.includedRefs.slice().sort()) !== canonicalJson(expectedSourceRefs(source))) {
      fail(`${source.name} execution-lock includedRefs differ from the manifest`);
    }
    for (const [label, relativePath] of [['mirror', locked.mirrorPath], ['bundle', locked.bundlePath]]) {
      const filename = resolveUnder(artifactRoot, relativePath, `${source.name} ${label} path`);
      if (!(await pathExists(filename))) fail(`${source.name} ${label} is missing: ${filename}`);
      await assertRealpathUnder(artifactRoot, filename, `${source.name} ${label}`);
    }
    const mirror = resolveUnder(artifactRoot, locked.mirrorPath, `${source.name} mirror path`);
    const bundle = resolveUnder(artifactRoot, locked.bundlePath, `${source.name} bundle path`);
    if (await sha256File(bundle) !== locked.bundleSha256) fail(`${source.name} bundle digest differs`);
    validateLocalSourceMetadata(mirror, source.name);
    if (git(mirror, ['rev-parse', '--show-object-format']).stdout.trim() !== locked.objectFormat) {
      fail(`${source.name} retained mirror object format differs`);
    }
    const mirrorRefs = git(mirror, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout
      .split('\n').filter(Boolean).sort();
    const mirrorRefNames = mirrorRefs.map((record) => record.split(' ')[0]);
    if (canonicalJson(mirrorRefNames) !== canonicalJson(locked.includedRefs.slice().sort())) {
      fail(`${source.name} retained mirror refs differ from includedRefs`);
    }
    const bundleRefs = git(artifactRoot, ['bundle', 'list-heads', bundle]).stdout
      .split('\n').filter(Boolean).map((record) => {
        const [objectId, ref] = record.split(' ');
        return `${ref} ${objectId}`;
      }).sort();
    if (canonicalJson(bundleRefs) !== canonicalJson(mirrorRefs)) fail(`${source.name} bundle refs differ from mirror refs`);
    git(mirror, ['bundle', 'verify', bundle]);
    const evidencePath = resolveUnder(artifactRoot, locked.evidence.path, `${source.name} execution evidence path`);
    if (await sha256File(evidencePath) !== locked.evidence.sha256) fail(`${source.name} execution evidence digest differs`);
    const evidence = await readJson(evidencePath);
    const expectedEvidence = {
      schemaVersion: 1,
      name: source.name,
      defaultHead: source.defaultHead,
      refs: mirrorRefs,
      bundleSha256: locked.bundleSha256,
    };
    if (canonicalJson(evidence) !== canonicalJson(expectedEvidence)) fail(`${source.name} execution evidence differs`);
  }
  for (const field of ['mirrorPath', 'bundlePath']) {
    const byParent = new Map();
    for (const source of executionLock.sources) {
      const parent = path.posix.dirname(source[field]);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(path.posix.basename(source[field]));
    }
    for (const [parent, expectedNames] of byParent) {
      const directory = resolveUnder(artifactRoot, parent, `${field} parent`);
      const actualNames = (await readdir(directory)).sort();
      if (canonicalJson(actualNames) !== canonicalJson(expectedNames.sort())) {
        fail(`${field} artifact directory has missing or extra entries: ${parent}`);
      }
    }
  }
}

export async function validateExecutionLock({
  contractRoot, artifactRoot, manifest, executionLock, filterRepo, expectedBase,
  fixture = false, requireCommittedControl = false,
}) {
  await validateExecutionLockPreflight({
    contractRoot, artifactRoot, manifest, executionLock, expectedBase, fixture, requireCommittedControl,
  });
  await validateExecutionLockInputs({
    artifactRoot, manifest, executionLock, fixture, requireCommittedControl,
  });
  const schemaRoot = path.join(contractRoot, 'migration/schemas');
  assertSha256(executionLock.targetBaseSourceManifestSha256, 'Execution lock targetBaseSourceManifestSha256');
  compareToolchain(manifest, executionLock, executionToolchain(filterRepo));

  const validator = executionLock.toolchain.contractSchemaValidator;
  if (validator.name !== CONTRACT_VALIDATOR_NAME || validator.version !== CONTRACT_VALIDATOR_VERSION) {
    fail('Execution lock contract-schema-validator identity differs');
  }
  const validateContract = await loadLockedValidator(artifactRoot, validator);
  await validateContract(executionLock, path.join(contractRoot, 'migration/schemas/execution-lock.schema.json'));
  const artifacts = [
    ['contract schema validator', validator.artifactPath, validator.artifactSha256],
    ['git-filter-repo artifact', executionLock.toolchain.gitFilterRepo.artifactPath, executionLock.toolchain.gitFilterRepo.artifactSha256],
    ['git-filter-repo wrapper', executionLock.toolchain.gitFilterRepo.wrapperPath, executionLock.toolchain.gitFilterRepo.wrapperSha256],
  ];
  for (const [label, relativePath, digest] of artifacts) {
    const filename = resolveUnder(artifactRoot, relativePath, `${label} path`);
    if (!(await pathExists(filename))) fail(`${label} is missing: ${filename}`);
    await assertRealpathUnder(artifactRoot, filename, label);
    if ((await stat(filename)).isDirectory()) fail(`${label} must be a file`);
    if (await sha256File(filename) !== digest) fail(`${label} digest differs`);
  }
  const wrapper = await realpath(resolveUnder(artifactRoot, executionLock.toolchain.gitFilterRepo.wrapperPath, 'wrapper path'));
  if (await realpath(filterRepo.command) !== wrapper) fail('git-filter-repo on PATH is not the execution-lock wrapper');

  if (executionLock.sources.length !== manifest.sources.length) fail('Execution lock source count differs from manifest');
  const official = !fixture;
  if (official && executionLock.sources.length !== 16) {
    fail('Official execution lock must contain exactly 16 sources');
  }
  if (official && requireCommittedControl) {
    if (git(artifactRoot, ['merge-base', '--is-ancestor', executionLock.targetBase, 'HEAD'], {
      allowFailure: true,
    }).status !== 0) fail('Locked target base is not an ancestor of the control checkout');
    if (git(artifactRoot, ['rev-list', '--merges', `${executionLock.targetBase}..HEAD`]).stdout.trim() !== '') {
      fail('Control branch is not linear after the locked target base');
    }
    if (git(artifactRoot, [
      'status', '--porcelain', '--untracked-files=no', '--',
      'migration/sources.json', 'migration/execution-lock.json',
      'migration/baselines.json', 'migration/package-classification.json', 'migration/control-evidence',
    ]).stdout !== '') fail('Control contracts/evidence have tracked modifications');
    const changedPaths = git(artifactRoot, [
      'diff', '--name-only', `${executionLock.targetBase}..HEAD`,
    ]).stdout.split('\n').filter(Boolean);
    const allowedControlPaths = new Set(CONTROL_FILES.map(([, filename]) => filename));
    const unexpectedPath = changedPaths.find((filename) => (
      !allowedControlPaths.has(filename) && !filename.startsWith(CONTROL_EVIDENCE_PREFIX)
    ));
    if (unexpectedPath) fail(`Control branch changes a non-control path: ${unexpectedPath}`);
  }
  assertUniqueBy(executionLock.sources, (source) => source.name, 'Execution lock sources');
  for (const [index, source] of manifest.sources.entries()) {
    const locked = executionLock.sources[index];
    if (locked.name !== source.name || locked.defaultHead !== source.defaultHead
      || locked.tagSnapshotSha256 !== source.tagSnapshotSha256) {
      fail(`Execution lock source facts differ at index ${index}`);
    }
    if (canonicalJson(locked.includedRefs.slice().sort()) !== canonicalJson(expectedSourceRefs(source))) {
      fail(`${source.name} execution-lock includedRefs differ from the manifest`);
    }
    for (const [label, relativePath] of [['mirror', locked.mirrorPath], ['bundle', locked.bundlePath]]) {
      const filename = resolveUnder(artifactRoot, relativePath, `${source.name} ${label} path`);
      if (!(await pathExists(filename))) fail(`${source.name} ${label} is missing: ${filename}`);
      await assertRealpathUnder(artifactRoot, filename, `${source.name} ${label}`);
    }
    const mirror = resolveUnder(artifactRoot, locked.mirrorPath, `${source.name} mirror path`);
    const bundle = resolveUnder(artifactRoot, locked.bundlePath, `${source.name} bundle path`);
    if (await sha256File(bundle) !== locked.bundleSha256) fail(`${source.name} bundle digest differs`);
    validateLocalSourceMetadata(mirror, source.name);
    if (git(mirror, ['rev-parse', '--show-object-format']).stdout.trim() !== locked.objectFormat) {
      fail(`${source.name} retained mirror object format differs`);
    }
    const mirrorRefs = git(mirror, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout
      .split('\n').filter(Boolean).sort();
    const mirrorRefNames = mirrorRefs.map((record) => record.split(' ')[0]);
    if (canonicalJson(mirrorRefNames) !== canonicalJson(locked.includedRefs.slice().sort())) {
      fail(`${source.name} retained mirror refs differ from includedRefs`);
    }
    const bundleRefs = git(artifactRoot, ['bundle', 'list-heads', bundle]).stdout
      .split('\n').filter(Boolean).map((record) => {
        const [objectId, ref] = record.split(' ');
        return `${ref} ${objectId}`;
      }).sort();
    if (canonicalJson(bundleRefs) !== canonicalJson(mirrorRefs)) fail(`${source.name} bundle refs differ from mirror refs`);
    git(mirror, ['bundle', 'verify', bundle]);
    const evidencePath = resolveUnder(artifactRoot, locked.evidence.path, `${source.name} execution evidence path`);
    if (await sha256File(evidencePath) !== locked.evidence.sha256) fail(`${source.name} execution evidence digest differs`);
    const evidence = await readJson(evidencePath);
    const expectedEvidence = {
      schemaVersion: 1,
      name: source.name,
      defaultHead: source.defaultHead,
      refs: mirrorRefs,
      bundleSha256: locked.bundleSha256,
    };
    if (canonicalJson(evidence) !== canonicalJson(expectedEvidence)) fail(`${source.name} execution evidence differs`);
  }
  for (const field of ['mirrorPath', 'bundlePath']) {
    const byParent = new Map();
    for (const source of executionLock.sources) {
      const parent = path.posix.dirname(source[field]);
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(path.posix.basename(source[field]));
    }
    for (const [parent, expectedNames] of byParent) {
      const directory = resolveUnder(artifactRoot, parent, `${field} parent`);
      const actualNames = (await readdir(directory)).sort();
      if (canonicalJson(actualNames) !== canonicalJson(expectedNames.sort())) {
        fail(`${field} artifact directory has missing or extra entries: ${parent}`);
      }
    }
  }
  return validateContract;
}

function validateBaselineDomain(baselines, manifest) {
  assertUniqueBy(baselines.entries, (entry) => entry.id, 'Baseline entry IDs');
  const sources = new Map(manifest.sources.map((source) => [source.name, source]));
  for (const entry of baselines.entries) {
    const source = sources.get(entry.source);
    if (!source) fail(`${entry.id} references an unknown baseline source`);
    if (entry.sourceCommit !== source.defaultHead) fail(`${entry.id} baseline source commit differs from the manifest`);
    if ((entry.result === 'waived-failure' || entry.lifecycleReview === 'waived') && entry.waiver === null) {
      fail(`${entry.id} requires a waiver`);
    }
  }
}

function validateClassificationDomain(classification, official) {
  for (const [label, records] of [
    ['manifest IDs', classification.manifests], ['edge IDs', classification.edges],
    ['resolution IDs', classification.resolutions], ['lifecycle IDs', classification.lifecycleHooks],
  ]) assertUniqueBy(records, (record) => record.id, `Package classification ${label}`);
  assertUniqueBy(classification.manifests, (record) => record.path, 'Package classification manifest paths');
  if (classification.inventoryManifestCount !== classification.manifests.length) {
    fail('Package classification inventoryManifestCount differs from manifests length');
  }
  const ownedFiles = new Map();
  for (const record of classification.manifests) {
    for (const ownedFile of record.ownedFiles) {
      if (ownedFiles.has(ownedFile)) fail(`${ownedFile} is owned by multiple package-classification manifests`);
      ownedFiles.set(ownedFile, record.id);
    }
  }
  const manifestPaths = new Set(classification.manifests.map((record) => record.path));
  for (const edge of classification.edges) {
    if (!manifestPaths.has(edge.consumerManifest)) fail(`${edge.id} references an unknown consumer manifest`);
  }
  for (const resolution of classification.resolutions) {
    if (!manifestPaths.has(resolution.owner)) fail(`${resolution.id} references an unknown resolution owner`);
  }
  for (const hook of classification.lifecycleHooks) {
    if (!manifestPaths.has(hook.manifest)) fail(`${hook.id} references an unknown lifecycle manifest`);
  }
  if (official && classification.inventoryManifestCount !== 44) fail('Official package classification must contain 44 inventory manifests');
}
export async function validateControlContracts({
  contractRoot, artifactRoot, manifest, executionLock, filterRepo, expectedBase,
  evidenceMode = 'control', validateArtifacts = true, fixture = false,
}) {
  let validateContract = validateJsonSchema;
  if (validateArtifacts) {
    validateContract = await validateExecutionLock({
      contractRoot, artifactRoot, manifest, executionLock, filterRepo, expectedBase,
      fixture, requireCommittedControl: true,
    });
  }
  for (const [, filename] of CONTROL_FILES) {
    const contractPath = path.join(contractRoot, filename);
    if (!(await pathExists(contractPath))) fail(`Control contract is missing: ${filename}`);
    await assertRealpathUnder(contractRoot, contractPath, 'control contract');
  }
  const baselinesPath = path.join(contractRoot, 'migration/baselines.json');
  const classificationPath = path.join(contractRoot, 'migration/package-classification.json');
  const [baselines, classification] = await Promise.all([readJson(baselinesPath), readJson(classificationPath)]);
  await Promise.all([
    validateContract(baselines, path.join(contractRoot, 'migration/schemas/baselines.schema.json')),
    validateContract(classification, path.join(contractRoot, 'migration/schemas/package-classification.schema.json')),
  ]);
  const executionLockPath = path.join(contractRoot, 'migration/execution-lock.json');
  const executionLockSha256 = await sha256File(executionLockPath);
  const manifestSha256 = await sha256File(path.join(contractRoot, 'migration/sources.json'));
  if (baselines.executionLockSha256 !== executionLockSha256
    || classification.executionLockSha256 !== executionLockSha256) fail('Dependent contract execution-lock digest differs');
  if (baselines.sourceManifestSha256 !== manifestSha256) fail('Baseline source-manifest digest differs');
  const baselinesSha256 = await sha256File(baselinesPath);
  if (classification.baselinesSha256 !== baselinesSha256) fail('Package-classification baseline digest differs');
  validateBaselineDomain(baselines, manifest);
  validateClassificationDomain(classification, !fixture);

  const discovered = [];
  collectEvidence(executionLock, 'execution-lock', discovered);
  collectEvidence(baselines, 'baselines', discovered);
  collectEvidence(classification, 'package-classification', discovered);
  const bySource = new Map();
  for (const evidence of discovered) {
    if (!evidence.path.startsWith(CONTROL_EVIDENCE_PREFIX)) fail(`${evidence.location} has invalid evidence path ${evidence.path}`);
    assertSha256(evidence.sha256, `${evidence.location} evidence digest`);
    const prior = bySource.get(evidence.path);
    if (prior && (prior.ownerContract !== evidence.ownerContract || prior.sha256 !== evidence.sha256)) {
      fail(`Control evidence path has conflicting ownership: ${evidence.path}`);
    }
    if (!prior) bySource.set(evidence.path, evidence);
  }
  const evidence = [...bySource.values()].sort((a, b) => a.path.localeCompare(b.path));
  const actualPrefix = evidenceMode === 'imported' ? IMPORTED_EVIDENCE_PREFIX : CONTROL_EVIDENCE_PREFIX;
  for (const record of evidence) {
    const actualPath = evidenceMode === 'imported' ? importedEvidencePath(record.path) : record.path;
    const filename = resolveUnder(contractRoot, actualPath, 'control evidence path');
    if (!(await pathExists(filename))) fail(`Control evidence is missing: ${actualPath}`);
    await assertRealpathUnder(contractRoot, filename, 'control evidence');
    if (await sha256File(filename) !== record.sha256) fail(`Control evidence digest differs: ${actualPath}`);
    record.sourcePath = record.path;
    record.destinationPath = importedEvidencePath(record.path);
  }
  if (!fixture) {
    const trackedPaths = [
      ...CONTROL_FILES.map(([, filename]) => filename),
      ...evidence.map((record) => record.sourcePath),
    ];
    if (git(artifactRoot, ['ls-files', '--error-unmatch', '--', ...trackedPaths], { allowFailure: true }).status !== 0) {
      fail('Official control contracts/evidence must be tracked in the control checkout');
    }
  }
  const root = path.join(contractRoot, actualPrefix.slice(0, -1));
  const actualFiles = (await recursiveFiles(root)).map((file) => `${actualPrefix}${file}`);
  const expectedFiles = evidence.map((record) => evidenceMode === 'imported' ? record.destinationPath : record.sourcePath).sort();
  if (canonicalJson(actualFiles.sort()) !== canonicalJson(expectedFiles)) fail('Control evidence tree has missing or extra files');
  return {
    baselines,
    classification,
    evidence,
    controlFiles: await buildControlFileRecords(contractRoot),
    validateContract,
  };
}

export async function buildControlFileRecords(contractRoot) {
  const records = [];
  for (const [id, filename] of CONTROL_FILES) {
    records.push({ id, source: filename, destination: filename, sha256: await sha256File(path.join(contractRoot, filename)) });
  }
  return records;
}

export async function copyControlTree({ controlRoot, destinationRoot, evidence }) {
  for (const [, filename] of CONTROL_FILES) {
    const destination = path.join(destinationRoot, filename);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(controlRoot, filename), destination);
  }
  for (const record of evidence) {
    const destination = path.join(destinationRoot, record.destinationPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(controlRoot, record.sourcePath), destination);
  }
}

export async function validateImportLock({
  repository, importLock, manifest, executionLock, controlRoot, filterRepo, fixture = false,
}) {
  const contract = await validateControlContracts({
    contractRoot: repository, artifactRoot: controlRoot, manifest, executionLock, filterRepo,
    expectedBase: executionLock.targetBase, evidenceMode: 'imported', validateArtifacts: true, fixture,
  });
  await contract.validateContract(importLock, path.join(repository, 'migration/schemas/import-lock.schema.json'));
  if (importLock.schemaVersion !== 2) fail('Import lock must use schemaVersion 2');
  if (importLock.targetBaseCommit !== executionLock.targetBase) fail('Import lock base differs from execution lock');
  if (importLock.manifest !== 'migration/sources.json'
    || importLock.manifestSha256 !== await sha256File(path.join(repository, importLock.manifest))
    || importLock.executionLock.path !== 'migration/execution-lock.json'
    || importLock.executionLock.sha256 !== await sha256File(path.join(repository, importLock.executionLock.path))) {
    fail('Import lock control digest differs');
  }
  if (canonicalJson(importLock.tools) !== canonicalJson(executionLock.toolchain)) fail('Import lock toolchain differs');
  const expectedTargetRefs = [
    `refs/heads/${manifest.target.baseBranch} ${executionLock.targetBase}`,
    `refs/remotes/origin/HEAD ${executionLock.targetBase}`,
    `refs/remotes/origin/${manifest.target.baseBranch} ${executionLock.targetBase}`,
  ].sort();
  if (canonicalJson(importLock.targetRefsBeforeImport) !== canonicalJson(expectedTargetRefs)) {
    fail('Import lock targetRefsBeforeImport differs');
  }
  if (importLock.outputBranch !== manifest.target.outputBranch) fail('Import lock outputBranch differs');
  const expectedControl = await buildControlFileRecords(repository);
  if (canonicalJson(importLock.controlFiles) !== canonicalJson(expectedControl)) fail('Import lock controlFiles differ');
  if (importLock.imports.length !== manifest.sources.length) fail('Import lock imports are incomplete');
  assertUniqueBy(importLock.imports, (record) => record.name, 'Import lock imports');
  for (const [index, source] of manifest.sources.entries()) {
    const record = importLock.imports[index];
    if (record.name !== source.name || record.sourceHead !== source.defaultHead
      || record.releaseTagCount !== source.releaseTags.length) fail(`${source.name} import-lock facts differ`);
  }
  const expectedEvidence = contract.evidence.map((record) => ({
    ownerContract: record.ownerContract,
    source: record.sourcePath,
    destination: record.destinationPath,
    sha256: record.sha256,
  }));
  if (canonicalJson(importLock.controlEvidence) !== canonicalJson(expectedEvidence)) fail('Import lock controlEvidence differs');
  return contract;
}
