#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  commitHasSignature, executionToolchain, generatedCommitEnv, git, pathExists,
  readJson, sha256File, sha256Tree, sourceTagSnapshotSha256, tagObjectHasSignature, validateManifest, writeJson,
} from './history-migration-lib.mjs';

const importer = fileURLToPath(new URL('./import-history.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('./verify-history.mjs', import.meta.url));
const inputLocker = fileURLToPath(new URL('./lock-history-inputs.mjs', import.meta.url));
const validator = fileURLToPath(new URL('./validate-migration-contract.mjs', import.meta.url));
const schemaSource = fileURLToPath(new URL('../migration/schemas', import.meta.url));
const keep = process.argv.includes('--keep');
const identity = { name: 'History Fixture', email: 'fixture@example.com' };
const timestamp = 1704067200;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(callback, expected, message) {
  try {
    callback();
  } catch (error) {
    if (error.message.includes(expected)) return;
    throw error;
  }
  throw new Error(message);
}

function runNode(script, controlRoot, args, expectedSuccess = true) {
  const bin = path.join(controlRoot, '.migration-work', 'bin');
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    maxBuffer: 128 * 1024 * 1024,
  });
  const succeeded = result.status === 0;
  if (succeeded !== expectedSuccess) {
    throw new Error(`Unexpected ${succeeded ? 'success' : 'failure'} (${result.status}) from ${path.basename(script)}\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function fileSha256(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function importArgs(fixture, controlRoot, mode, output, extra = []) {
  const executionLock = path.join(controlRoot, 'migration/execution-lock.json');
  return [
    '--manifest', path.join(controlRoot, 'migration/sources.json'),
    '--execution-lock', executionLock,
    '--execution-lock-sha256', fileSha256(executionLock),
    '--control-root', controlRoot,
    '--source-mode', mode,
    '--fixture',
    '--base', fixture.base,
    '--output', output,
    ...extra,
  ];
}

function verifyArgs(fixture, controlRoot, mode, repository, extra = []) {
  const executionLock = path.join(repository, 'migration/execution-lock.json');
  return [
    '--repo', repository,
    '--manifest', path.join(repository, 'migration/sources.json'),
    '--execution-lock', executionLock,
    '--execution-lock-sha256', fileSha256(executionLock),
    '--control-root', controlRoot,
    '--source-mode', mode,
    '--fixture',
    ...extra,
  ];
}

async function directoryDigest(directory, relative = '') {
  const hash = createHash('sha256');
  const current = path.join(directory, relative);
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) hash.update(await directoryDigest(directory, child));
    else hash.update(`${child}\0`).update(await readFile(path.join(directory, child)));
  }
  return hash.digest('hex');
}

function refSnapshot(repository) {
  return git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout.split('\n').filter(Boolean).sort();
}

async function clearWorktree(repository) {
  for (const entry of await readdir(repository)) {
    if (entry !== '.git') await rm(path.join(repository, entry), { recursive: true, force: true });
  }
}

function commit(repository, message) {
  git(repository, ['add', '.']);
  git(repository, ['commit', '--no-gpg-sign', '-m', message], { env: generatedCommitEnv(identity, timestamp) });
  return git(repository, ['rev-parse', 'HEAD']).stdout.trim();
}

function tagRecord(repository, name, include) {
  const sourceRef = `refs/tags/${name}`;
  const objectId = git(repository, ['rev-parse', sourceRef]).stdout.trim();
  const objectType = git(repository, ['cat-file', '-t', objectId]).stdout.trim();
  const targetCommit = git(repository, ['rev-parse', `${sourceRef}^{commit}`]).stdout.trim();
  const targetTree = git(repository, ['rev-parse', `${targetCommit}^{tree}`]).stdout.trim();
  const packageJson = JSON.parse(git(repository, ['show', `${targetCommit}:package.json`]).stdout);
  const record = {
    name, sourceRef, normalizedTagVersion: name.replace(/^v/, ''), objectId, objectType, targetCommit, targetTree,
    targetCommitSigned: commitHasSignature(repository, targetCommit),
    reachableFromDefault: git(repository, ['merge-base', '--is-ancestor', targetCommit, 'refs/heads/master'], {
      allowFailure: true,
    }).status === 0,
    observedRootPackageVersion: packageJson.version,
    classification: include ? 'root-package-version-match' : 'root-package-version-mismatch',
  };
  if (include) record.targetName = `fixture@${name}`;
  if (objectType === 'tag') record.tagObjectSigned = tagObjectHasSignature(repository, objectId);
  return record;
}

async function writeEvidence(controlRoot, relativePath, value) {
  const filename = path.join(controlRoot, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeJson(filename, value);
  return { path: relativePath, sha256: await sha256File(filename) };
}

async function rechainContracts(controlRoot) {
  const manifestPath = path.join(controlRoot, 'migration/sources.json');
  const lockPath = path.join(controlRoot, 'migration/execution-lock.json');
  const baselinesPath = path.join(controlRoot, 'migration/baselines.json');
  const classificationPath = path.join(controlRoot, 'migration/package-classification.json');
  const lock = await readJson(lockPath);
  lock.sourceManifestSha256 = await sha256File(manifestPath);
  await writeJson(lockPath, lock);
  const baselines = await readJson(baselinesPath);
  baselines.executionLockSha256 = await sha256File(lockPath);
  baselines.sourceManifestSha256 = await sha256File(manifestPath);
  await writeJson(baselinesPath, baselines);
  const classification = await readJson(classificationPath);
  classification.executionLockSha256 = await sha256File(lockPath);
  classification.baselinesSha256 = await sha256File(baselinesPath);
  await writeJson(classificationPath, classification);
}

async function createFixture(root) {
  const sourceWork = path.join(root, 'source-work');
  const controlRoot = path.join(root, 'control');
  const sourceBare = path.join(controlRoot, '.migration-work', 'sources', 'fixture.git');
  await mkdir(sourceWork);
  await mkdir(path.dirname(sourceBare), { recursive: true });
  git(sourceWork, ['init', '-b', 'master', '--quiet']);
  await mkdir(path.join(sourceWork, 'integration'));
  await writeFile(path.join(sourceWork, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(sourceWork, 'index.js'), 'one\n');
  await writeFile(path.join(sourceWork, 'executable.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(sourceWork, 'executable.sh'), 0o755);
  await symlink('index.js', path.join(sourceWork, 'index-link.js'));
  await writeFile(path.join(sourceWork, 'integration/test.txt'), 'fixture\n');
  const releaseOne = commit(sourceWork, 'release one');
  git(sourceWork, ['tag', '1.0.0']);
  git(sourceWork, ['branch', 'side']);
  await writeFile(path.join(sourceWork, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
  await writeFile(path.join(sourceWork, 'index.js'), 'one\ntwo\n');
  commit(sourceWork, 'prepare release two');
  git(sourceWork, ['switch', 'side', '--quiet']);
  await writeFile(path.join(sourceWork, 'side.txt'), 'side branch\n');
  commit(sourceWork, 'side branch');
  git(sourceWork, ['switch', 'master', '--quiet']);
  git(sourceWork, ['merge', '--no-ff', '--no-gpg-sign', '-m', 'merge side branch', 'side'], {
    env: generatedCommitEnv(identity, timestamp),
  });
  git(sourceWork, ['branch', '-D', 'side']);
  const mergeHead = git(sourceWork, ['rev-parse', 'HEAD']).stdout.trim();
  const signedTree = git(sourceWork, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const signedCommitFile = path.join(root, 'signed-commit.txt');
  await writeFile(signedCommitFile, [
    `tree ${signedTree}`, `parent ${mergeHead}`,
    `author ${identity.name} <${identity.email}> ${timestamp} +0000`,
    `committer ${identity.name} <${identity.email}> ${timestamp} +0000`,
    'gpgsig -----BEGIN PGP SIGNATURE-----', ' ZmFrZS1jb21taXQtc2lnbmF0dXJl', ' -----END PGP SIGNATURE-----',
    '', `release two; preserve ${releaseOne}`, '',
  ].join('\n'));
  const signedHead = git(sourceWork, ['hash-object', '-t', 'commit', '-w', signedCommitFile]).stdout.trim();
  git(sourceWork, ['update-ref', 'refs/heads/master', signedHead, mergeHead]);
  git(sourceWork, ['reset', '--hard', '--quiet', signedHead]);
  const signedTagFile = path.join(root, 'signed-tag.txt');
  await writeFile(signedTagFile, [
    `object ${signedHead}`, 'type commit', 'tag v2.0.0',
    `tagger ${identity.name} <${identity.email}> ${timestamp} +0000`, 'encoding UTF-8', '', 'release two', '',
    '-----BEGIN PGP SIGNATURE-----', 'ZmFrZS10YWctc2lnbmF0dXJl', '-----END PGP SIGNATURE-----', '',
  ].join('\n'));
  const signedTag = git(sourceWork, ['hash-object', '-t', 'tag', '-w', signedTagFile]).stdout.trim();
  git(sourceWork, ['update-ref', 'refs/tags/v2.0.0', signedTag]);
  git(sourceWork, ['tag', 'artifact']);
  git(sourceWork, ['switch', '--orphan', 'tag-only', '--quiet']);
  await clearWorktree(sourceWork);
  await writeFile(path.join(sourceWork, 'package.json'), '{"name":"fixture","version":"1.5.0"}\n');
  await writeFile(path.join(sourceWork, 'tag-only.txt'), 'tag only\n');
  commit(sourceWork, 'tag-only release');
  git(sourceWork, ['tag', '1.5.0']);
  git(sourceWork, ['switch', 'master', '--quiet']);
  git(sourceWork, ['branch', '-D', 'tag-only']);
  await writeFile(path.join(sourceWork, 'package.json'), '{"name":"fixture","version":"2.1.0"}\n');
  const head = commit(sourceWork, 'new qualifying release');
  git(sourceWork, ['tag', '2.1.0']);
  git(root, ['clone', '--bare', '--quiet', sourceWork, sourceBare]);

  const releaseTags = ['1.0.0', '1.5.0', 'v2.0.0', '2.1.0'].map((name) => tagRecord(sourceBare, name, true));
  const excludedTags = [tagRecord(sourceBare, 'artifact', false)];
  const source = {
    name: 'fixture', url: `file://${sourceBare}`, defaultBranch: 'master', sourceRef: 'refs/heads/master',
    defaultHead: head, defaultHeadTree: git(sourceBare, ['rev-parse', `${head}^{tree}`]).stdout.trim(),
    defaultBranchCommitCount: Number(git(sourceBare, ['rev-list', '--count', head]).stdout.trim()),
    destinationPrefix: 'lib', tagNamespace: 'fixture@', releaseTags, excludedTags,
    signedDefaultBranchCommitCount: 1, moves: [{ from: 'lib/integration', to: 'integration' }],
  };
  source.tagSnapshotSha256 = sourceTagSnapshotSha256(source);

  const targetWork = path.join(root, 'target-work');
  const targetBare = path.join(root, 'target.git');
  await mkdir(targetWork);
  git(targetWork, ['init', '-b', 'main', '--quiet']);
  await writeFile(path.join(targetWork, 'README.md'), '# target\n');
  await mkdir(path.join(targetWork, 'migration'), { recursive: true });
  await cp(schemaSource, path.join(targetWork, 'migration/schemas'), { recursive: true });
  await writeJson(path.join(targetWork, 'migration/sources.json'), { schemaVersion: 0, fixtureBase: true });
  let base = commit(targetWork, 'initial target');
  git(root, ['clone', '--bare', '--quiet', targetWork, targetBare]);

  await cp(schemaSource, path.join(controlRoot, 'migration/schemas'), { recursive: true });
  await mkdir(path.join(controlRoot, 'tools'), { recursive: true });
  await copyFile(validator, path.join(controlRoot, 'tools/validate-migration-contract.mjs'));
  const bin = path.join(controlRoot, '.migration-work/bin');
  const artifacts = path.join(controlRoot, '.migration-work/artifacts');
  await mkdir(bin, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const artifactPath = path.join(artifacts, 'git_filter_repo.py');
  const resolvedArtifact = spawnSync('uv', [
    'run', '--no-project', '--with', 'git-filter-repo==2.47.0', 'python3', '-c',
    'import git_filter_repo; print(git_filter_repo.__file__)',
  ], { encoding: 'utf8', env: process.env });
  if (resolvedArtifact.status !== 0) throw new Error(`Could not materialize fixture filter-repo artifact: ${resolvedArtifact.stderr}`);
  await copyFile(resolvedArtifact.stdout.trim(), artifactPath);
  const pythonResult = spawnSync('python3', [
    '-c', 'import os, sys; print(os.path.realpath(sys.executable))',
  ], { encoding: 'utf8', env: process.env });
  if (pythonResult.status !== 0) throw new Error(`Could not resolve fixture Python: ${pythonResult.stderr}`);
  const pythonExecutable = pythonResult.stdout.trim();
  const wrapperPath = path.join(bin, 'git-filter-repo');
  await writeFile(wrapperPath, [
    '#!/bin/sh',
    'set -eu',
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    "ARTIFACT_RELATIVE='../artifacts/git_filter_repo.py'",
    `exec '${pythonExecutable.replaceAll("'", `'"'"'`)}' "$SCRIPT_DIR/$ARTIFACT_RELATIVE" "$@"`,
    '',
  ].join('\n'));
  await chmod(wrapperPath, 0o755);
  await writeFile(path.join(bin, 'uvx'), [
    '#!/bin/sh', `touch ${JSON.stringify(path.join(root, 'locked-uvx-called'))}`, 'exit 99', '',
  ].join('\n'));
  await chmod(path.join(bin, 'uvx'), 0o755);
  const wrapperSha256 = await sha256File(wrapperPath);
  const wrapperVersion = spawnSync(wrapperPath, ['--version'], { encoding: 'utf8', env: process.env });
  if (wrapperVersion.status !== 0) throw new Error(`Fixture filter-repo artifact failed: ${wrapperVersion.stderr}`);
  assert(wrapperVersion.stdout.trim() === 'a40bce548d2c', `Unexpected fixture filter-repo version ${wrapperVersion.stdout.trim()}`);
  const currentToolchain = executionToolchain({
    command: wrapperPath,
    version: wrapperVersion.stdout.trim(),
    executableSha256: wrapperSha256,
  });
  const historyToolchain = {
    ...currentToolchain,
    gitFilterRepoExecutableSha256: wrapperSha256,
  };
  const manifest = {
    schemaVersion: 1, sourceSnapshotDate: '2024-01-01',
    target: {
      url: `file://${targetBare}`, baseBranch: 'main', baseCommit: null,
      baseCommitPolicy: 'fixture requires --base', outputBranch: 'migration/history-import',
    },
    historyToolchain, generatedCommitIdentity: identity,
    tagPolicy: { description: 'fixture', renamedFormat: '<source-name>@<original-tag>' }, sources: [source],
  };
  const manifestPath = path.join(controlRoot, 'migration/sources.json');
  await writeJson(manifestPath, manifest);
  await copyFile(manifestPath, path.join(targetWork, 'migration/sources.json'));
  base = commit(targetWork, 'record fixture base manifest');
  await rm(targetBare, { recursive: true, force: true });
  git(root, ['clone', '--bare', '--quiet', targetWork, targetBare]);

  const bundlePath = path.join(controlRoot, '.migration-work/bundles/fixture.bundle');
  await mkdir(path.dirname(bundlePath), { recursive: true });
  const includedRefs = [source.sourceRef, ...releaseTags.map((tag) => tag.sourceRef), ...excludedTags.map((tag) => tag.sourceRef)].sort();
  git(sourceBare, ['bundle', 'create', bundlePath, ...includedRefs]);
  const mirrorRefs = refSnapshot(sourceBare);
  const executionEvidence = await writeEvidence(controlRoot, 'migration/control-evidence/execution-lock/fixture.json', {
    schemaVersion: 1, name: source.name, defaultHead: source.defaultHead, refs: mirrorRefs,
    bundleSha256: await sha256File(bundlePath),
  });
  const executionLock = {
    schemaVersion: 1, decisionDate: '2024-01-01', targetBase: base,
    targetBaseSourceManifestSha256: await sha256File(path.join(targetWork, 'migration/sources.json')),
    sourceManifestSha256: await sha256File(manifestPath),
    toolchain: {
      node: currentToolchain.node, nodeLtsLine: currentToolchain.node.replace(/^v/, '').split('.')[0], npm: currentToolchain.npm,
      git: currentToolchain.git,
      python: currentToolchain.python,
      pythonExecutable,
      pythonExecutableSha256: await sha256File(pythonExecutable),
      uv: currentToolchain.uv,
      contractSchemaBundleSha256: await sha256Tree(path.join(controlRoot, 'migration/schemas')),
      gitFilterRepo: {
        packageVersion: currentToolchain.gitFilterRepoPackageVersion,
        reportedVersion: currentToolchain.gitFilterRepoReportedVersion,
        artifactPath: '.migration-work/artifacts/git_filter_repo.py', artifactSha256: await sha256File(artifactPath),
        wrapperPath: '.migration-work/bin/git-filter-repo', wrapperSha256,
      },
      contractSchemaValidator: {
        name: 'ui-router-contract-validator', version: '1', artifactPath: 'tools/validate-migration-contract.mjs',
        artifactSha256: await sha256File(path.join(controlRoot, 'tools/validate-migration-contract.mjs')),
      },
      runtime: {
        osImage: 'fixture', osImageDigest: 'sha256:fixture', architecture: process.arch,
        timezone: 'UTC', locale: 'C', browser: null,
      },
    },
    sources: [{
      name: source.name, defaultHead: source.defaultHead, tagSnapshotSha256: source.tagSnapshotSha256,
      mirrorPath: '.migration-work/sources/fixture.git', bundlePath: '.migration-work/bundles/fixture.bundle',
      bundleSha256: await sha256File(bundlePath), objectFormat: 'sha1', includedRefs,
      retentionOwner: 'fixture', evidence: executionEvidence,
    }],
  };
  const executionLockPath = path.join(controlRoot, 'migration/execution-lock.json');
  await writeJson(executionLockPath, executionLock);

  const baselineEvidence = await writeEvidence(controlRoot, 'migration/control-evidence/baselines/fixture.json', { ok: true });
  const baselines = {
    schemaVersion: 1, executionLockSha256: await sha256File(executionLockPath),
    sourceManifestSha256: await sha256File(manifestPath),
    entries: [{
      id: 'fixture.static', source: 'fixture', sourceCommit: head, sourcePath: 'package.json',
      discoveredFrom: ['package.json'], workflowMatrixKey: null, downstreamGroup: null, downstreamProject: null,
      owner: 'fixture', lane: 'static', command: { cwd: 'fixture', argv: ['true'], environment: {}, expectedStatus: 0 },
      packageManager: { name: 'npm', version: currentToolchain.npm, lockPolicy: 'no-lock-reviewed' },
      runtime: {
        node: currentToolchain.node, osImageDigest: 'sha256:fixture', architecture: process.arch,
        timezone: 'UTC', locale: 'C', browser: null,
      },
      lifecycleReview: 'none', result: 'pass', expectedFailureReason: null,
      evidence: baselineEvidence, waiver: null,
    }],
  };
  const baselinesPath = path.join(controlRoot, 'migration/baselines.json');
  await writeJson(baselinesPath, baselines);
  const classificationEvidence = await writeEvidence(controlRoot, 'migration/control-evidence/package-classification/fixture.json', { ok: true });
  await writeJson(path.join(controlRoot, 'migration/package-classification.json'), {
    schemaVersion: 1, executionLockSha256: await sha256File(executionLockPath),
    baselinesSha256: await sha256File(baselinesPath), inventoryManifestCount: 1,
    manifests: [{
      id: 'fixture', path: 'lib/package.json', origin: 'imported', class: 'fixture', published: false,
      private: true, workspace: false, lockOwner: 'none', finalName: 'fixture', owningLane: 'fixture',
      ownedFiles: ['lib/package.json'], internalResolutionMode: 'none', evidence: classificationEvidence,
    }],
    edges: [], resolutions: [], lifecycleHooks: [],
  });
  return { base, controlRoot, sourceBare, targetBare, targetWork };
}
async function copyControl(source, destination) {
  await cp(source, destination, { recursive: true });
  return destination;
}

async function retargetControl(controlRoot, targetBare, targetWork, base) {
  const manifestPath = path.join(controlRoot, 'migration/sources.json');
  const lockPath = path.join(controlRoot, 'migration/execution-lock.json');
  const manifest = await readJson(manifestPath);
  manifest.target.url = `file://${targetBare}`;
  await writeJson(manifestPath, manifest);
  const lock = await readJson(lockPath);
  lock.targetBase = base;
  lock.targetBaseSourceManifestSha256 = await sha256File(path.join(targetWork, 'migration/sources.json'));
  await writeJson(lockPath, lock);
  await rechainContracts(controlRoot);
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uirouter-history-test-'));
  let succeeded = false;
  try {
    const officialManifest = await readJson(fileURLToPath(new URL('../migration/sources.json', import.meta.url)));
    const refreshedOfficialManifest = structuredClone(officialManifest);
    const refreshedTag = structuredClone(refreshedOfficialManifest.sources[0].releaseTags[0]);
    refreshedTag.name = '999.0.0';
    refreshedTag.sourceRef = 'refs/tags/999.0.0';
    refreshedTag.normalizedTagVersion = '999.0.0';
    refreshedTag.observedRootPackageVersion = '999.0.0';
    refreshedTag.targetName = `${refreshedOfficialManifest.sources[0].name}@999.0.0`;
    refreshedOfficialManifest.sources[0].releaseTags.push(refreshedTag);
    refreshedOfficialManifest.sources[0].tagSnapshotSha256 = sourceTagSnapshotSha256(
      refreshedOfficialManifest.sources[0],
    );
    validateManifest(refreshedOfficialManifest);
    officialManifest.sources[0].url = 'file:///tmp/not-an-official-source.git';
    assertThrows(
      () => validateManifest(officialManifest),
      'canonical public source URL',
      'Official manifest accepted a local source URL',
    );
    const fixture = await createFixture(root);
    const fixtureManifest = await readJson(path.join(fixture.controlRoot, 'migration/sources.json'));
    const networkFixture = structuredClone(fixtureManifest);
    networkFixture.sources[0].url = 'https://example.com/source.git';
    assertThrows(
      () => validateManifest(networkFixture, { fixture: true }),
      'must be local in fixture mode',
      'Fixture manifest accepted a network source',
    );
    const multiSourceFixture = structuredClone(fixtureManifest);
    multiSourceFixture.sources.push(structuredClone(multiSourceFixture.sources[0]));
    assertThrows(
      () => validateManifest(multiSourceFixture, { fixture: true }),
      'exactly one source',
      'Fixture manifest accepted multiple sources',
    );
    const fixtureExecutionLock = await readJson(path.join(fixture.controlRoot, 'migration/execution-lock.json'));
    const lockerArgs = (mode, controlRoot) => [
      '--mode', mode, '--control-root', controlRoot, '--base', fixture.base, '--fixture',
      '--decision-date', '2024-01-01', '--node-lts-line', process.version.replace(/^v/, '').split('.')[0],
      '--filter-repo-artifact', '.migration-work/artifacts/git_filter_repo.py',
      '--filter-repo-artifact-sha256', fixtureExecutionLock.toolchain.gitFilterRepo.artifactSha256,
      '--filter-repo-wrapper', '.migration-work/bin/git-filter-repo',
      '--filter-repo-wrapper-sha256', fixtureExecutionLock.toolchain.gitFilterRepo.wrapperSha256,
      '--filter-repo-package-version', '2.47.0',
      '--schema-validator-artifact', 'tools/validate-migration-contract.mjs',
      '--schema-validator-sha256', fixtureExecutionLock.toolchain.contractSchemaValidator.artifactSha256,
      '--python-executable', fixtureExecutionLock.toolchain.pythonExecutable,
      '--python-executable-sha256', fixtureExecutionLock.toolchain.pythonExecutableSha256,
      '--os-image', 'fixture', '--os-image-digest', 'sha256:fixture', '--retention-owner', 'fixture',
      ...(mode === 'check' ? [
        '--execution-lock-sha256', fileSha256(path.join(controlRoot, 'migration/execution-lock.json')),
      ] : []),
    ];
    const unreviewedLockControl = await copyControl(fixture.controlRoot, path.join(root, 'control-unreviewed-lock'));
    const unreviewedMarker = path.join(root, 'unreviewed-python-executed');
    const unreviewedExecutable = path.join(root, 'unreviewed-python');
    await writeFile(unreviewedExecutable, `#!/bin/sh\ntouch ${JSON.stringify(unreviewedMarker)}\nexit 1\n`);
    await chmod(unreviewedExecutable, 0o755);
    const unreviewedLockPath = path.join(unreviewedLockControl, 'migration/execution-lock.json');
    const unreviewedLock = await readJson(unreviewedLockPath);
    unreviewedLock.toolchain.pythonExecutable = unreviewedExecutable;
    unreviewedLock.toolchain.pythonExecutableSha256 = fileSha256(unreviewedExecutable);
    await writeJson(unreviewedLockPath, unreviewedLock);
    const reviewedLockDigestFailure = runNode(importer, unreviewedLockControl, importArgs(
      fixture, unreviewedLockControl, 'mirror', path.join(root, 'failure-unreviewed-lock-output'),
      ['--execution-lock-sha256', fileSha256(path.join(fixture.controlRoot, 'migration/execution-lock.json'))],
    ), false);
    assert(reviewedLockDigestFailure.includes('separately reviewed digest'), 'Unreviewed lock digest was accepted');
    assert(!(await pathExists(unreviewedMarker)), 'Unreviewed lock-selected executable ran before digest validation');

    const prehashControl = await copyControl(fixture.controlRoot, path.join(root, 'control-prehash'));
    await rm(path.join(prehashControl, 'migration/execution-lock.json'));
    await rm(path.join(prehashControl, 'migration/control-evidence'), { recursive: true, force: true });
    const executionMarker = path.join(root, 'unreviewed-artifact-executed');
    await writeFile(path.join(prehashControl, '.migration-work/artifacts/git_filter_repo.py'), [
      'from pathlib import Path', `Path(${JSON.stringify(executionMarker)}).write_text("executed")`, '',
    ].join('\n'));
    const prehashFailure = runNode(inputLocker, prehashControl, [
      ...lockerArgs('generate', prehashControl),
      '--mirror-root', '.migration-work/prehash-sources',
      '--bundle-root', '.migration-work/prehash-bundles',
    ], false);
    assert(prehashFailure.includes('pre-reviewed digest'), 'Unreviewed filter artifact was accepted by H01 generation');
    assert(!(await pathExists(executionMarker)), 'H01 executed the filter artifact before checking its reviewed digest');

    const wrapperProbeControl = await copyControl(fixture.controlRoot, path.join(root, 'control-wrapper-probe'));
    await rm(path.join(wrapperProbeControl, 'migration/execution-lock.json'));
    await rm(path.join(wrapperProbeControl, 'migration/control-evidence'), { recursive: true, force: true });
    const wrapperMarker = path.join(root, 'h01-wrapper-executed');
    const directProbeMarker = path.join(root, 'h01-direct-artifact-probed');
    const pythonShim = path.join(root, 'locked-python-shim');
    const realPython = fixtureExecutionLock.toolchain.pythonExecutable;
    await writeFile(pythonShim, [
      '#!/bin/sh',
      `if [ "\${1:-}" = "--version" ]; then exec '${realPython}' --version; fi`,
      `if [ "\${UIROUTER_DIRECT_ARTIFACT_PROBE:-}" = "1" ]; then touch '${directProbeMarker}'; else touch '${wrapperMarker}'; fi`,
      `exec '${realPython}' "$@"`,
      '',
    ].join('\n'));
    await chmod(pythonShim, 0o755);
    const wrapperProbePath = path.join(wrapperProbeControl, '.migration-work/bin/git-filter-repo');
    const wrapperProbeContents = [
      '#!/bin/sh',
      'set -eu',
      'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      "ARTIFACT_RELATIVE='../artifacts/git_filter_repo.py'",
      `exec '${pythonShim}' "$SCRIPT_DIR/$ARTIFACT_RELATIVE" "$@"`,
      '',
    ].join('\n');
    await writeFile(wrapperProbePath, wrapperProbeContents);
    await chmod(wrapperProbePath, 0o755);
    runNode(inputLocker, wrapperProbeControl, [
      ...lockerArgs('generate', wrapperProbeControl),
      '--python-executable', pythonShim,
      '--python-executable-sha256', fileSha256(pythonShim),
      '--filter-repo-wrapper-sha256', fileSha256(wrapperProbePath),
      '--mirror-root', '.migration-work/wrapper-probe-sources',
      '--bundle-root', '.migration-work/wrapper-probe-bundles',
    ]);
    assert(await pathExists(directProbeMarker), 'H01 generation did not execute the direct artifact probe');
    assert(!(await pathExists(wrapperMarker)), 'H01 generation executed the wrapper instead of the direct artifact probe');
    await rm(directProbeMarker);
    const wrapperProbeBundle = path.join(
      wrapperProbeControl, '.migration-work/wrapper-probe-bundles/fixture.bundle',
    );
    await writeFile(wrapperProbeBundle, Buffer.concat([await readFile(wrapperProbeBundle), Buffer.from('tampered')]));
    const preProbeInputFailure = runNode(inputLocker, wrapperProbeControl, [
      ...lockerArgs('check', wrapperProbeControl),
      '--python-executable', pythonShim,
      '--python-executable-sha256', fileSha256(pythonShim),
      '--filter-repo-wrapper-sha256', fileSha256(wrapperProbePath),
      '--mirror-root', '.migration-work/wrapper-probe-sources',
      '--bundle-root', '.migration-work/wrapper-probe-bundles',
    ], false);
    assert(preProbeInputFailure.includes('bundle digest differs'), 'H01 check accepted a tampered retained bundle');
    assert(!(await pathExists(directProbeMarker)), 'H01 check ran the direct artifact probe before retained-input validation');
    assert(!(await pathExists(wrapperMarker)), 'H01 check executed the wrapper before retained-input validation');

    const symlinkWriteControl = await copyControl(fixture.controlRoot, path.join(root, 'control-symlink-write'));
    await rm(path.join(symlinkWriteControl, 'migration/execution-lock.json'));
    await rm(path.join(symlinkWriteControl, 'migration/control-evidence'), { recursive: true, force: true });
    await rm(path.join(symlinkWriteControl, '.migration-work/bin'), { recursive: true, force: true });
    const escapedBin = path.join(root, 'escaped-bin');
    await mkdir(escapedBin);
    await symlink(escapedBin, path.join(symlinkWriteControl, '.migration-work/bin'));
    const symlinkWriteFailure = runNode(inputLocker, symlinkWriteControl, [
      ...lockerArgs('generate', symlinkWriteControl),
      '--mirror-root', '.migration-work/symlink-sources',
      '--bundle-root', '.migration-work/symlink-bundles',
    ], false);
    assert(symlinkWriteFailure.includes('symbolic-link component'), `H01 generation accepted a symlinked write parent: ${symlinkWriteFailure}`);
    assert(!(await pathExists(path.join(escapedBin, 'git-filter-repo'))), 'H01 generation wrote through a symlinked parent');

    const generatedControl = await copyControl(fixture.controlRoot, path.join(root, 'control-generated'));
    await rm(path.join(generatedControl, 'migration/execution-lock.json'));
    await rm(path.join(generatedControl, 'migration/baselines.json'));
    await rm(path.join(generatedControl, 'migration/package-classification.json'));
    await rm(path.join(generatedControl, 'migration/control-evidence'), { recursive: true, force: true });
    runNode(inputLocker, generatedControl, [
      ...lockerArgs('generate', generatedControl),
      '--mirror-root', '.migration-work/generated-sources',
      '--bundle-root', '.migration-work/generated-bundles',
    ]);
    runNode(inputLocker, generatedControl, lockerArgs('check', generatedControl));
    const generatedManifest = await readJson(path.join(generatedControl, 'migration/sources.json'));
    const generatedLock = await readJson(path.join(generatedControl, 'migration/execution-lock.json'));
    assert(generatedLock.sources.length === 1, 'Generated execution lock omitted the fixture source');
    assert(generatedManifest.sources[0].releaseTags.some((tag) => tag.name === '2.1.0'),
      'H01 refresh omitted the new qualifying release tag');
    assert(generatedLock.sources[0].includedRefs.includes('refs/tags/2.1.0'),
      'Execution lock omitted the new qualifying release ref');
    const generatedMirror = path.join(generatedControl, generatedLock.sources[0].mirrorPath);
    assert(git(generatedMirror, ['rev-parse', '--verify', 'refs/tags/2.1.0']).stdout.trim() !== '',
      'Retained mirror omitted the new qualifying release ref');
    const generatedBundle = path.join(generatedControl, generatedLock.sources[0].bundlePath);
    assert(git(generatedControl, ['bundle', 'list-heads', generatedBundle]).stdout.includes('refs/tags/2.1.0'),
      'Offline bundle omitted the new qualifying release ref');

    runNode(inputLocker, fixture.controlRoot, lockerArgs('check', fixture.controlRoot));
    const staleCheckControl = await copyControl(fixture.controlRoot, path.join(root, 'control-stale-check'));
    const staleCheckLock = path.join(staleCheckControl, 'migration/execution-lock.json');
    const reviewedCheckDigest = fileSha256(staleCheckLock);
    await writeFile(staleCheckLock, `${await readFile(staleCheckLock, 'utf8')} `);
    const staleCheckFailure = runNode(inputLocker, staleCheckControl, [
      ...lockerArgs('check', staleCheckControl), '--execution-lock-sha256', reviewedCheckDigest,
    ], false);
    assert(staleCheckFailure.includes('separately reviewed digest'), 'H01 check accepted stale execution-lock bytes');

    const outputs = new Map();
    for (const mode of ['remote', 'mirror', 'bundle']) {
      const output = path.join(root, `output-${mode}`);
      runNode(importer, fixture.controlRoot, importArgs(fixture, fixture.controlRoot, mode, output));
      outputs.set(mode, output);
    }
    const heads = [...outputs.values()].map((repository) => git(repository, ['rev-parse', 'HEAD']).stdout.trim());
    assert(new Set(heads).size === 1, 'Remote/mirror/bundle final HEADs differ');
    for (const repository of outputs.values()) {
      assert(git(repository, ['rev-parse', '--verify', 'refs/tags/fixture@2.1.0']).stdout.trim() !== '',
        'Imported repository omitted the newly qualifying release tag');
    }
    const refSets = [...outputs.values()].map((repository) => JSON.stringify(refSnapshot(repository)));
    assert(new Set(refSets).size === 1, 'Remote/mirror/bundle ref namespaces differ');
    const lockTexts = await Promise.all([...outputs.values()].map((repository) => (
      readFile(path.join(repository, 'migration/import-lock.json'), 'utf8')
    )));
    assert(new Set(lockTexts).size === 1, 'Remote/mirror/bundle import locks differ');
    for (const filename of [
      'migration/sources.json', 'migration/execution-lock.json',
      'migration/baselines.json', 'migration/package-classification.json',
    ]) {
      const contents = await Promise.all([...outputs.values()].map((repository) => (
        readFile(path.join(repository, filename), 'utf8')
      )));
      assert(new Set(contents).size === 1, `Remote/mirror/bundle ${filename} bytes differ`);
    }
    const evidenceDigests = await Promise.all([...outputs.values()].map((repository) => (
      directoryDigest(path.join(repository, 'migration/evidence'))
    )));
    assert(new Set(evidenceDigests).size === 1, 'Remote/mirror/bundle evidence trees differ');

    assert(!(await pathExists(path.join(root, 'locked-uvx-called'))), 'Locked imports invoked uvx from PATH');
    const output = outputs.get('mirror');
    await access(path.join(output, 'integration/test.txt'));
    assert(!(await pathExists(path.join(output, 'lib/integration'))), 'Layout source still exists');
    assert(git(output, ['show', 'fixture@1.5.0:lib/tag-only.txt']).stdout === 'tag only\n', 'Tag-only history missing');
    assert(!(await pathExists(path.join(output, 'lib/tag-only.txt'))), 'Tag-only file leaked onto current branch');
    for (const [mode, repository] of outputs) {
      const report = path.join(root, `verification-${mode}.json`);
      runNode(verifier, fixture.controlRoot, verifyArgs(fixture, fixture.controlRoot, mode, repository, ['--report', report]));
      assert((await readJson(report)).ok === true, `${mode} verifier report did not pass`);
    }

    const inRepositoryReportFailure = runNode(verifier, fixture.controlRoot, verifyArgs(
      fixture, fixture.controlRoot, 'mirror', output,
      ['--report', path.join(output, 'migration/verification.json')],
    ), false);
    assert(inRepositoryReportFailure.includes('--report must be outside'), 'Verifier accepted an in-repository report path');
    const controlAlias = path.join(root, 'control-alias');
    await symlink(fixture.controlRoot, controlAlias);
    const physicalOverlapFailure = runNode(importer, fixture.controlRoot, importArgs(
      fixture, fixture.controlRoot, 'mirror', path.join(controlAlias, 'unsafe-output'),
    ), false);
    assert(physicalOverlapFailure.includes('physically overlap'), 'Importer accepted a symlink-aliased control/output overlap');

    const missingLockFailure = runNode(verifier, fixture.controlRoot, [
      '--repo', output, '--manifest', path.join(output, 'migration/sources.json'),
    ], false);
    assert(missingLockFailure.includes('--execution-lock is required'), 'Verifier accepted an implicit execution lock');

    const nestedRoot = path.join(root, 'failure-nested');
    const nestedFailure = runNode(importer, fixture.controlRoot, importArgs(
      fixture, fixture.controlRoot, 'mirror', path.join(nestedRoot, 'output'), ['--workdir', nestedRoot],
    ), false);
    assert(nestedFailure.includes('must not be equal, nested, or otherwise overlap'), 'Nested paths were accepted');
    assert(!(await pathExists(nestedRoot)), 'Nested-path failure mutated the filesystem');

    const toolchainControl = await copyControl(fixture.controlRoot, path.join(root, 'control-toolchain'));
    const toolchainManifest = await readJson(path.join(toolchainControl, 'migration/sources.json'));
    const toolchainLock = await readJson(path.join(toolchainControl, 'migration/execution-lock.json'));
    toolchainManifest.historyToolchain.npm = '0.0.0-fixture-mismatch';
    toolchainLock.toolchain.npm = '0.0.0-fixture-mismatch';
    await writeJson(path.join(toolchainControl, 'migration/sources.json'), toolchainManifest);
    await writeJson(path.join(toolchainControl, 'migration/execution-lock.json'), toolchainLock);
    await rechainContracts(toolchainControl);
    const toolchainFailure = runNode(importer, toolchainControl, importArgs(
      fixture, toolchainControl, 'mirror', path.join(root, 'failure-toolchain-output'),
    ), false);
    assert(toolchainFailure.includes('History toolchain mismatch'), 'Toolchain mismatch was not explicit');

    const artifactControl = await copyControl(fixture.controlRoot, path.join(root, 'control-artifact'));
    await writeFile(path.join(artifactControl, '.migration-work/artifacts/git_filter_repo.py'), 'substituted\n');
    const artifactFailure = runNode(importer, artifactControl, importArgs(
      fixture, artifactControl, 'mirror', path.join(root, 'failure-artifact-output'),
    ), false);
    assert(artifactFailure.includes('git-filter-repo artifact digest differs'), 'Artifact substitution was accepted');

    const wrapperControl = await copyControl(fixture.controlRoot, path.join(root, 'control-wrapper'));
    await writeFile(path.join(wrapperControl, '.migration-work/bin/git-filter-repo'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(wrapperControl, '.migration-work/bin/git-filter-repo'), 0o755);
    const wrapperFailure = runNode(importer, wrapperControl, importArgs(
      fixture, wrapperControl, 'mirror', path.join(root, 'failure-wrapper-output'),
    ), false);
    assert(wrapperFailure.includes('git-filter-repo wrapper digest differs'), 'Wrapper substitution was accepted');

    const validatorControl = await copyControl(fixture.controlRoot, path.join(root, 'control-validator'));
    await writeFile(path.join(validatorControl, 'tools/validate-migration-contract.mjs'), 'substituted\n');
    const validatorFailure = runNode(importer, validatorControl, importArgs(
      fixture, validatorControl, 'mirror', path.join(root, 'failure-validator-output'),
    ), false);
    assert(validatorFailure.includes('schema validator digest differs'), 'Schema-validator substitution was accepted');

    const schemaControl = await copyControl(fixture.controlRoot, path.join(root, 'control-schema'));
    await writeFile(path.join(schemaControl, 'migration/schemas/execution-lock.schema.json'), '{}\n');
    const schemaFailure = runNode(importer, schemaControl, importArgs(
      fixture, schemaControl, 'mirror', path.join(root, 'failure-schema-output'),
    ), false);
    assert(schemaFailure.includes('Contract schema bundle digest differs'), 'Schema substitution was accepted');

    const schemaSymlinkControl = await copyControl(fixture.controlRoot, path.join(root, 'control-schema-symlink'));
    await rm(path.join(schemaSymlinkControl, 'migration/schemas'), { recursive: true, force: true });
    await symlink(path.join(fixture.controlRoot, 'migration/schemas'), path.join(schemaSymlinkControl, 'migration/schemas'));
    const schemaSymlinkFailure = runNode(importer, schemaSymlinkControl, importArgs(
      fixture, schemaSymlinkControl, 'mirror', path.join(root, 'failure-schema-symlink-output'),
    ), false);
    assert(schemaSymlinkFailure.includes('schema root'), 'Symlinked schema root was accepted');

    const bundleControl = await copyControl(fixture.controlRoot, path.join(root, 'control-bundle'));
    await writeFile(path.join(bundleControl, '.migration-work/bundles/fixture.bundle'), 'substituted\n');
    const bundleFailure = runNode(importer, bundleControl, importArgs(
      fixture, bundleControl, 'bundle', path.join(root, 'failure-bundle-output'),
    ), false);
    assert(bundleFailure.includes('bundle digest differs'), 'Bundle substitution was accepted');

    const extraEvidenceControl = await copyControl(fixture.controlRoot, path.join(root, 'control-extra-evidence'));
    await writeFile(path.join(extraEvidenceControl, 'migration/control-evidence/extra.json'), '{}\n');
    const extraEvidenceFailure = runNode(importer, extraEvidenceControl, importArgs(
      fixture, extraEvidenceControl, 'mirror', path.join(root, 'failure-extra-evidence-output'),
    ), false);
    assert(extraEvidenceFailure.includes('missing or extra files'), 'Extra control evidence was accepted');

    const missingControl = await copyControl(fixture.controlRoot, path.join(root, 'control-missing'));
    await rm(path.join(missingControl, 'migration/baselines.json'));
    const missingControlFailure = runNode(importer, missingControl, importArgs(
      fixture, missingControl, 'mirror', path.join(root, 'failure-missing-control-output'),
    ), false);
    assert(missingControlFailure.includes('Control contract is missing'), 'Missing dependent control was accepted');

    const staleControl = await copyControl(fixture.controlRoot, path.join(root, 'control-stale-base'));
    const staleLock = await readJson(path.join(staleControl, 'migration/execution-lock.json'));
    staleLock.targetBase = '0'.repeat(40);
    await writeJson(path.join(staleControl, 'migration/execution-lock.json'), staleLock);
    await rechainContracts(staleControl);
    const staleFailure = runNode(importer, staleControl, importArgs(
      fixture, staleControl, 'mirror', path.join(root, 'failure-stale-output'),
    ), false);
    assert(staleFailure.includes('differs from --base'), 'Stale target-base lock was accepted');

    const baseManifestControl = await copyControl(fixture.controlRoot, path.join(root, 'control-base-manifest'));
    const baseManifestLock = await readJson(path.join(baseManifestControl, 'migration/execution-lock.json'));
    baseManifestLock.targetBaseSourceManifestSha256 = '0'.repeat(64);
    await writeJson(path.join(baseManifestControl, 'migration/execution-lock.json'), baseManifestLock);
    await rechainContracts(baseManifestControl);
    const baseManifestFailure = runNode(importer, baseManifestControl, importArgs(
      fixture, baseManifestControl, 'mirror', path.join(root, 'failure-base-manifest-output'),
      ['--workdir', path.join(root, 'failure-base-manifest-work')],
    ), false);
    assert(baseManifestFailure.includes('Locked target-base source manifest digest differs'), 'Base-manifest mismatch was accepted');

    const mirrorControl = await copyControl(fixture.controlRoot, path.join(root, 'control-mirror-ref'));
    git(path.join(mirrorControl, '.migration-work/sources/fixture.git'), [
      'update-ref', 'refs/heads/unreviewed', 'refs/heads/master',
    ]);
    const mirrorFailure = runNode(importer, mirrorControl, importArgs(
      fixture, mirrorControl, 'mirror', path.join(root, 'failure-mirror-output'),
    ), false);
    assert(mirrorFailure.includes('retained mirror refs differ'), 'Retained-mirror ref drift was accepted');

    const driftRemote = path.join(root, 'source-drift.git');
    git(root, ['clone', '--bare', '--quiet', fixture.sourceBare, driftRemote]);
    git(driftRemote, ['update-ref', 'refs/tags/unreviewed', 'refs/heads/master']);
    const driftControl = await copyControl(fixture.controlRoot, path.join(root, 'control-source-drift'));
    const driftManifest = await readJson(path.join(driftControl, 'migration/sources.json'));
    driftManifest.sources[0].url = `file://${driftRemote}`;
    await writeJson(path.join(driftControl, 'migration/sources.json'), driftManifest);
    await rechainContracts(driftControl);
    const driftFailure = runNode(importer, driftControl, importArgs(
      fixture, driftControl, 'remote', path.join(root, 'failure-source-drift-output'),
      ['--workdir', path.join(root, 'failure-source-drift-work')],
    ), false);
    assert(driftFailure.includes('tag set drifted'), 'Remote source-tag drift was accepted');
    assert(await pathExists(path.join(root, 'failure-source-drift-work')), 'Source drift did not preserve its workdir');

    const replacementControl = await copyControl(fixture.controlRoot, path.join(root, 'control-replacement'));
    const replacementMirror = path.join(replacementControl, '.migration-work/sources/fixture.git');
    const replacedCommit = git(replacementMirror, ['rev-parse', 'refs/tags/1.0.0^{commit}']).stdout.trim();
    git(replacementMirror, ['update-ref', `refs/replace/${replacedCommit}`, 'refs/heads/master']);
    const replacementFailure = runNode(importer, replacementControl, importArgs(
      fixture, replacementControl, 'mirror', path.join(root, 'failure-replacement-output'),
    ), false);
    assert(replacementFailure.includes('retained mirror refs differ'), 'Replacement ref was accepted');

    for (const [label, relativePath, contents] of [
      ['graft', 'info/grafts', `${replacedCommit}\n`],
      ['alternate', 'objects/info/alternates', '/tmp/unsafe-alternate\n'],
    ]) {
      const metadataControl = await copyControl(fixture.controlRoot, path.join(root, `control-${label}`));
      const metadataPath = path.join(metadataControl, '.migration-work/sources/fixture.git', relativePath);
      await mkdir(path.dirname(metadataPath), { recursive: true });
      await writeFile(metadataPath, contents);
      const metadataFailure = runNode(importer, metadataControl, importArgs(
        fixture, metadataControl, 'mirror', path.join(root, `failure-${label}-output`),
      ), false);
      assert(metadataFailure.includes('unsafe Git metadata before clone'), `${label} metadata was accepted`);
    }

    const tamperedOutput = outputs.get('bundle');
    const originalTamperedHead = git(tamperedOutput, ['rev-parse', 'HEAD']).stdout.trim();
    const refsPath = path.join(tamperedOutput, 'migration/evidence/imports/fixture/refs.json');
    const refsEvidence = await readJson(refsPath);
    refsEvidence.sourceHead = '0'.repeat(40);
    await writeJson(refsPath, refsEvidence);
    git(tamperedOutput, ['add', '--', 'migration/evidence/imports/fixture/refs.json']);
    git(tamperedOutput, ['commit', '--amend', '--no-edit', '--no-gpg-sign'], { env: generatedCommitEnv(identity, timestamp) });
    const mapFailure = runNode(verifier, fixture.controlRoot, verifyArgs(
      fixture, fixture.controlRoot, 'bundle', tamperedOutput,
    ), false);
    assert(mapFailure.includes('refs evidence differs'), 'Ref-evidence tampering was accepted');
    git(tamperedOutput, ['reset', '--hard', '--quiet', originalTamperedHead]);
    const summaryPath = path.join(tamperedOutput, 'migration/evidence/summary.json');
    const summary = await readJson(summaryPath);
    summary.baseCommit = '0'.repeat(40);
    await writeJson(summaryPath, summary);
    git(tamperedOutput, ['add', '--', 'migration/evidence/summary.json']);
    git(tamperedOutput, ['commit', '--amend', '--no-edit', '--no-gpg-sign'], { env: generatedCommitEnv(identity, timestamp) });
    const summaryFailure = runNode(verifier, fixture.controlRoot, verifyArgs(
      fixture, fixture.controlRoot, 'bundle', tamperedOutput,
    ), false);
    assert(summaryFailure.includes('Summary evidence differs'), 'Summary tampering was accepted');
    git(tamperedOutput, ['reset', '--hard', '--quiet', originalTamperedHead]);
    const refsLockPath = path.join(tamperedOutput, 'migration/import-lock.json');
    const refsLock = await readJson(refsLockPath);
    refsLock.targetRefsBeforeImport = [`refs/heads/forged ${refsLock.targetBaseCommit}`];
    await writeJson(refsLockPath, refsLock);
    const refsSummary = await readJson(summaryPath);
    refsSummary.targetRefsBeforeImport = refsLock.targetRefsBeforeImport;
    await writeJson(summaryPath, refsSummary);
    git(tamperedOutput, ['add', '--', 'migration/import-lock.json', 'migration/evidence/summary.json']);
    git(tamperedOutput, ['commit', '--amend', '--no-edit', '--no-gpg-sign'], { env: generatedCommitEnv(identity, timestamp) });
    const lockedRefsFailure = runNode(verifier, fixture.controlRoot, verifyArgs(
      fixture, fixture.controlRoot, 'bundle', tamperedOutput,
    ), false);
    assert(lockedRefsFailure.includes('targetRefsBeforeImport differs'), 'Forged pre-import refs were accepted');
    git(tamperedOutput, ['reset', '--hard', '--quiet', originalTamperedHead]);

    const branchLock = await readJson(refsLockPath);
    branchLock.outputBranch = 'forged/output';
    await writeJson(refsLockPath, branchLock);
    const branchSummary = await readJson(summaryPath);
    branchSummary.outputBranch = branchLock.outputBranch;
    await writeJson(summaryPath, branchSummary);
    git(tamperedOutput, ['add', '--', 'migration/import-lock.json', 'migration/evidence/summary.json']);
    git(tamperedOutput, ['commit', '--amend', '--no-edit', '--no-gpg-sign'], { env: generatedCommitEnv(identity, timestamp) });
    const outputBranchFailure = runNode(verifier, fixture.controlRoot, verifyArgs(
      fixture, fixture.controlRoot, 'bundle', tamperedOutput,
    ), false);
    assert(outputBranchFailure.includes('outputBranch differs'), 'Forged output branch was accepted');
    git(tamperedOutput, ['reset', '--hard', '--quiet', originalTamperedHead]);

    git(tamperedOutput, ['update-ref', 'refs/notes/unexpected', 'HEAD']);
    const extraRefFailure = runNode(verifier, fixture.controlRoot, verifyArgs(
      fixture, fixture.controlRoot, 'bundle', tamperedOutput,
    ), false);
    assert(extraRefFailure.includes('Final ref namespace differs'), 'Extra assembled ref was accepted');
    git(tamperedOutput, ['update-ref', '-d', 'refs/notes/unexpected']);
    await mkdir(path.join(tamperedOutput, 'migration/control-evidence'), { recursive: true });
    await writeFile(path.join(tamperedOutput, 'migration/control-evidence/leaked.json'), '{}\n');
    git(tamperedOutput, ['add', '--', 'migration/control-evidence/leaked.json']);
    git(tamperedOutput, ['commit', '--amend', '--no-edit', '--no-gpg-sign'], { env: generatedCommitEnv(identity, timestamp) });
    const leakedControlEvidenceFailure = runNode(verifier, fixture.controlRoot, verifyArgs(
      fixture, fixture.controlRoot, 'bundle', tamperedOutput,
    ), false);
    assert(leakedControlEvidenceFailure.includes('contains migration/control-evidence'),
      'Verifier accepted leaked control-evidence paths');
    git(tamperedOutput, ['reset', '--hard', '--quiet', originalTamperedHead]);

    git(fixture.targetBare, ['update-ref', 'refs/tags/preexisting', fixture.base]);
    const targetTagFailure = runNode(importer, fixture.controlRoot, importArgs(
      fixture, fixture.controlRoot, 'mirror', path.join(root, 'failure-target-tag-output'),
    ), false);
    assert(targetTagFailure.includes('Target already has tags'), 'Pre-existing target tag was accepted');
    git(fixture.targetBare, ['update-ref', '-d', 'refs/tags/preexisting']);
    git(fixture.targetBare, ['update-ref', 'refs/heads/unexpected', fixture.base]);
    const targetRefFailure = runNode(importer, fixture.controlRoot, importArgs(
      fixture, fixture.controlRoot, 'mirror', path.join(root, 'failure-target-ref-output'),
    ), false);
    assert(targetRefFailure.includes('Target pre-import ref set differs'), 'Extra target ref was accepted');
    git(fixture.targetBare, ['update-ref', '-d', 'refs/heads/unexpected']);

    const reservedPaths = [
      'migration/execution-lock.json',
      'migration/baselines.json',
      'migration/package-classification.json',
      'migration/import-lock.json',
      'migration/control-evidence/preexisting.txt',
      'migration/evidence/preexisting.txt',
    ];
    for (const [index, reservedPath] of reservedPaths.entries()) {
      const reservedWork = path.join(root, `reserved-target-work-${index}`);
      await cp(fixture.targetWork, reservedWork, { recursive: true });
      await mkdir(path.dirname(path.join(reservedWork, reservedPath)), { recursive: true });
      await writeFile(path.join(reservedWork, reservedPath), 'reserved\n');
      const reservedBase = commit(reservedWork, `add reserved path ${index}`);
      const reservedBare = path.join(root, `reserved-target-${index}.git`);
      git(root, ['clone', '--bare', '--quiet', reservedWork, reservedBare]);
      const reservedControl = await copyControl(fixture.controlRoot, path.join(root, `control-reserved-${index}`));
      await retargetControl(reservedControl, reservedBare, reservedWork, reservedBase);
      const reservedFixture = { ...fixture, base: reservedBase };
      const reservedFailure = runNode(importer, reservedControl, importArgs(
        reservedFixture, reservedControl, 'mirror', path.join(root, `failure-reserved-output-${index}`),
      ), false);
      assert(reservedFailure.includes('reserved control/evidence paths'), `Reserved target path was accepted: ${reservedPath}`);
    }

    const collisionWork = path.join(root, 'collision-target-work');
    await cp(fixture.targetWork, collisionWork, { recursive: true });
    await writeFile(path.join(collisionWork, 'lib'), 'target file collides with imported directory\n');
    const collisionBase = commit(collisionWork, 'add target collision');
    const collisionBare = path.join(root, 'collision-target.git');
    git(root, ['clone', '--bare', '--quiet', collisionWork, collisionBare]);
    const collisionControl = await copyControl(fixture.controlRoot, path.join(root, 'control-collision'));
    await retargetControl(collisionControl, collisionBare, collisionWork, collisionBase);
    const collisionFixture = { ...fixture, base: collisionBase };
    const collisionFailure = runNode(importer, collisionControl, importArgs(
      collisionFixture, collisionControl, 'mirror', path.join(root, 'failure-collision-output'),
    ), false);
    assert(collisionFailure.includes('source/target tree collision before merge'), 'Tree collision was accepted');

    console.log('HISTORY_MIGRATION_FIXTURE_OK');
    succeeded = true;
  } finally {
    if (succeeded && !keep) await rm(root, { recursive: true, force: true });
    else console.log(`Fixture state: ${root}`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
