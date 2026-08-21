#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  commitHasSignature,
  executionToolchain,
  filterRepoVersion,
  generatedCommitEnv,
  git,
  pathExists,
  readJson,
  sourceTagSnapshotSha256,
  tagObjectHasSignature,
  writeJson,
} from './history-migration-lib.mjs';

const importer = fileURLToPath(new URL('./import-history.mjs', import.meta.url));
const verifier = fileURLToPath(new URL('./verify-history.mjs', import.meta.url));
const keep = process.argv.includes('--keep');
const identity = { name: 'History Fixture', email: 'fixture@example.com' };
const timestamp = 1704067200;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(script, args, expectedSuccess = true) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const succeeded = result.status === 0;
  if (succeeded !== expectedSuccess) {
    throw new Error(
      `Unexpected ${succeeded ? 'success' : 'failure'} (${result.status}) from ${path.basename(script)}\n`
      + `${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}\n${result.stderr}`;
}

async function directoryDigest(directory, relative = '') {
  const hash = createHash('sha256');
  const current = path.join(directory, relative);
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => (
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  ))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) hash.update(await directoryDigest(directory, child));
    else hash.update(`${child}\0`).update(await readFile(path.join(directory, child)));
  }
  return hash.digest('hex');
}

function refs(repository) {
  return git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout;
}

async function clearWorktree(repository) {
  for (const entry of await readdir(repository)) {
    if (entry !== '.git') await rm(path.join(repository, entry), { recursive: true, force: true });
  }
}

function commit(repository, message) {
  git(repository, ['add', '.']);
  git(repository, ['commit', '--no-gpg-sign', '-m', message], {
    env: generatedCommitEnv(identity, timestamp),
  });
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
    name,
    sourceRef,
    normalizedTagVersion: name.replace(/^v/, ''),
    objectId,
    objectType,
    targetCommit,
    targetTree,
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

async function createFixture(root, historyToolchain) {
  const targetWork = path.join(root, 'target-work');
  const targetBare = path.join(root, 'target.git');
  await mkdir(targetWork);
  git(targetWork, ['init', '-b', 'main', '--quiet']);
  await writeFile(path.join(targetWork, 'README.md'), '# target\n');
  const base = commit(targetWork, 'initial target');
  git(root, ['clone', '--bare', '--quiet', targetWork, targetBare]);

  const sourceWork = path.join(root, 'source-work');
  const sourceRoot = path.join(root, 'source-mirrors');
  const sourceBare = path.join(sourceRoot, 'fixture.git');
  await mkdir(sourceWork);
  await mkdir(sourceRoot);
  git(sourceWork, ['init', '-b', 'master', '--quiet']);
  await mkdir(path.join(sourceWork, 'integration'));
  await writeFile(path.join(sourceWork, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(sourceWork, 'index.js'), 'one\n');
  await writeFile(path.join(sourceWork, 'executable.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(sourceWork, 'executable.sh'), 0o755);
  await symlink('index.js', path.join(sourceWork, 'index-link.js'));
  await writeFile(path.join(sourceWork, 'integration', 'test.txt'), 'fixture\n');
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
  const signedCommitFile = path.join(root, 'signed-commit.txt');
  const signedTree = git(sourceWork, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  await writeFile(signedCommitFile, [
    `tree ${signedTree}`,
    `parent ${mergeHead}`,
    `author ${identity.name} <${identity.email}> ${timestamp} +0000`,
    `committer ${identity.name} <${identity.email}> ${timestamp} +0000`,
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ZmFrZS1jb21taXQtc2lnbmF0dXJl',
    ' -----END PGP SIGNATURE-----',
    '',
    `release two; preserve ${releaseOne}`,
    '',
  ].join('\n'));
  const head = git(sourceWork, ['hash-object', '-t', 'commit', '-w', signedCommitFile]).stdout.trim();
  git(sourceWork, ['update-ref', 'refs/heads/master', head, mergeHead]);
  git(sourceWork, ['reset', '--hard', '--quiet', head]);
  const signedTagFile = path.join(root, 'signed-tag.txt');
  await writeFile(signedTagFile, [
    `object ${head}`,
    'type commit',
    'tag v2.0.0',
    `tagger ${identity.name} <${identity.email}> ${timestamp} +0000`,
    '',
    'release two',
    '',
    '-----BEGIN PGP SIGNATURE-----',
    'ZmFrZS10YWctc2lnbmF0dXJl',
    '-----END PGP SIGNATURE-----',
    '',
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
  git(root, ['clone', '--bare', '--quiet', sourceWork, sourceBare]);

  const releaseTags = ['1.0.0', '1.5.0', 'v2.0.0'].map((name) => tagRecord(sourceBare, name, true));
  const excludedTags = [tagRecord(sourceBare, 'artifact', false)];
  const source = {
    name: 'fixture',
    url: `file://${sourceBare}`,
    defaultBranch: 'master',
    sourceRef: 'refs/heads/master',
    defaultHead: head,
    defaultHeadTree: git(sourceBare, ['rev-parse', `${head}^{tree}`]).stdout.trim(),
    defaultBranchCommitCount: Number(git(sourceBare, ['rev-list', '--count', head]).stdout.trim()),
    destinationPrefix: 'lib',
    tagNamespace: 'fixture@',
    releaseTags,
    excludedTags,
    signedDefaultBranchCommitCount: 1,
    moves: [{ from: 'lib/integration', to: 'integration' }],
  };
  source.tagSnapshotSha256 = sourceTagSnapshotSha256(source);
  const manifest = {
    schemaVersion: 1,
    sourceSnapshotDate: '2024-01-01',
    target: {
      url: `file://${targetBare}`,
      baseBranch: 'main',
      baseCommit: null,
      baseCommitPolicy: 'fixture requires --base',
      outputBranch: 'migration/history-import',
    },
    historyToolchain,
    generatedCommitIdentity: identity,
    tagPolicy: { description: 'fixture', renamedFormat: '<source-name>@<original-tag>' },
    sources: [source],
  };
  const manifestPath = path.join(root, 'manifest.json');
  await writeJson(manifestPath, manifest);
  return {
    base, manifestPath, sourceBare, sourceRoot, targetBare, targetWork,
  };
}

async function main() {
  const filterRepo = filterRepoVersion();
  assert(filterRepo.version === 'a40bce548d2c', `Expected git-filter-repo 2.47.0/a40bce548d2c, got ${filterRepo.version}`);
  const historyToolchain = executionToolchain(filterRepo);
  const root = await mkdtemp(path.join(os.tmpdir(), 'uirouter-history-test-'));
  let succeeded = false;
  try {
    const {
      base, manifestPath, sourceBare, sourceRoot, targetBare, targetWork,
    } = await createFixture(root, historyToolchain);
    const outputOne = path.join(root, 'output-1');
    const outputTwo = path.join(root, 'output-2');
    runNode(importer, ['--manifest', manifestPath, '--base', base, '--output', outputOne]);
    runNode(importer, [
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--base', base,
      '--output', outputTwo,
    ]);
    assert(git(outputOne, ['rev-parse', 'HEAD']).stdout === git(outputTwo, ['rev-parse', 'HEAD']).stdout, 'Final HEAD differs');
    assert(refs(outputOne) === refs(outputTwo), 'Final ref namespaces differ');
    assert(
      await readFile(path.join(outputOne, 'migration/import-lock.json'), 'utf8')
        === await readFile(path.join(outputTwo, 'migration/import-lock.json'), 'utf8'),
      'Import locks differ',
    );
    assert(
      await directoryDigest(path.join(outputOne, 'migration/evidence'))
        === await directoryDigest(path.join(outputTwo, 'migration/evidence')),
      'Evidence trees differ',
    );
    await access(path.join(outputOne, 'integration/test.txt'));
    assert(!(await pathExists(path.join(outputOne, 'lib/integration'))), 'Layout source still exists');
    assert(git(outputOne, ['show', 'fixture@1.5.0:lib/tag-only.txt']).stdout === 'tag only\n', 'Tag-only history missing');
    assert(!(await pathExists(path.join(outputOne, 'lib/tag-only.txt'))), 'Tag-only file leaked onto current branch');

    const report = path.join(root, 'verification.json');
    runNode(verifier, [
      '--repo', outputOne,
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--report', report,
    ]);
    assert((await readJson(report)).ok === true, 'Verifier report did not pass');

    const nestedRoot = path.join(root, 'failure-nested-paths');
    const nestedFailure = runNode(importer, [
      '--manifest', manifestPath,
      '--base', base,
      '--workdir', nestedRoot,
      '--output', path.join(nestedRoot, 'output'),
    ], false);
    assert(nestedFailure.includes('must not be equal, nested, or otherwise overlap'), 'Nested-path failure was not explicit');
    assert(!(await pathExists(nestedRoot)), 'Nested-path failure mutated the filesystem');

    const toolchainManifest = await readJson(manifestPath);
    toolchainManifest.historyToolchain.npm = '0.0.0-fixture-mismatch';
    const toolchainManifestPath = path.join(root, 'toolchain-mismatch-manifest.json');
    await writeJson(toolchainManifestPath, toolchainManifest);
    const toolchainFailure = runNode(importer, [
      '--manifest', toolchainManifestPath,
      '--base', base,
      '--workdir', path.join(root, 'failure-toolchain-work'),
      '--output', path.join(root, 'failure-toolchain-output'),
    ], false);
    assert(toolchainFailure.includes('History toolchain mismatch'), 'Toolchain mismatch failure was not explicit');
    assert(!(await pathExists(path.join(root, 'failure-toolchain-work'))), 'Toolchain mismatch created a workdir');

    const replacedCommit = git(sourceBare, ['rev-parse', 'refs/tags/1.0.0^{commit}']).stdout.trim();
    git(sourceBare, ['update-ref', `refs/replace/${replacedCommit}`, 'refs/heads/master']);
    const replacementFailure = runNode(importer, [
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--base', base,
      '--workdir', path.join(root, 'failure-replacement-work'),
      '--output', path.join(root, 'failure-replacement-output'),
    ], false);
    assert(replacementFailure.includes('source contains replacement refs'), 'Replacement-ref import failure was not explicit');
    const replacementVerifyFailure = runNode(verifier, [
      '--repo', outputOne,
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--workdir', path.join(root, 'failure-replacement-verify-work'),
    ], false);
    assert(replacementVerifyFailure.includes('source contains replacement refs'), 'Replacement-ref verify failure was not explicit');
    git(sourceBare, ['update-ref', '-d', `refs/replace/${replacedCommit}`]);

    await mkdir(path.join(sourceBare, 'info'), { recursive: true });
    await writeFile(path.join(sourceBare, 'info', 'grafts'), `${replacedCommit}\n`);
    const graftFailure = runNode(importer, [
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--base', base,
      '--workdir', path.join(root, 'failure-graft-work'),
      '--output', path.join(root, 'failure-graft-output'),
    ], false);
    assert(graftFailure.includes('unsafe Git metadata before clone: info/grafts'), 'Graft import failure was not explicit');
    const graftVerifyFailure = runNode(verifier, [
      '--repo', outputOne,
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--workdir', path.join(root, 'failure-graft-verify-work'),
    ], false);
    assert(graftVerifyFailure.includes('unsafe Git metadata before clone: info/grafts'), 'Graft verify failure was not explicit');
    await rm(path.join(sourceBare, 'info', 'grafts'));

    await mkdir(path.join(sourceBare, 'objects', 'info'), { recursive: true });
    await writeFile(path.join(sourceBare, 'objects', 'info', 'alternates'), '/tmp/unsafe-alternate\n');
    const alternatesFailure = runNode(importer, [
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--base', base,
      '--workdir', path.join(root, 'failure-alternates-work'),
      '--output', path.join(root, 'failure-alternates-output'),
    ], false);
    assert(alternatesFailure.includes('unsafe Git metadata before clone: objects/info/alternates'), 'Alternates import failure was not explicit');
    const alternatesVerifyFailure = runNode(verifier, [
      '--repo', outputOne,
      '--manifest', manifestPath,
      '--source-root', sourceRoot,
      '--workdir', path.join(root, 'failure-alternates-verify-work'),
    ], false);
    assert(alternatesVerifyFailure.includes('unsafe Git metadata before clone: objects/info/alternates'), 'Alternates verify failure was not explicit');
    await rm(path.join(sourceBare, 'objects', 'info', 'alternates'));

    git(outputTwo, ['update-ref', 'refs/notes/unexpected', 'HEAD']);
    const extraRefFailure = runNode(verifier, [
      '--repo', outputTwo,
      '--manifest', manifestPath,
      '--workdir', path.join(root, 'failure-extra-ref-verify-work'),
    ], false);
    assert(extraRefFailure.includes('Final ref namespace differs'), 'Extra-ref failure was not explicit');
    git(outputTwo, ['update-ref', '-d', 'refs/notes/unexpected']);

    const originalOutputTwoHead = git(outputTwo, ['rev-parse', 'HEAD']).stdout.trim();
    const tamperedRefsPath = path.join(outputTwo, 'migration/evidence/fixture/refs.json');
    const tamperedRefs = await readJson(tamperedRefsPath);
    tamperedRefs.sourceHead = '0'.repeat(40);
    await writeJson(tamperedRefsPath, tamperedRefs);
    git(outputTwo, ['add', 'migration/evidence/fixture/refs.json']);
    git(outputTwo, ['commit', '--amend', '--no-edit', '--no-gpg-sign'], {
      env: generatedCommitEnv(identity, timestamp),
    });
    const evidenceFailure = runNode(verifier, [
      '--repo', outputTwo,
      '--manifest', manifestPath,
      '--workdir', path.join(root, 'failure-evidence-verify-work'),
    ], false);
    assert(evidenceFailure.includes('refs.json evidence differs'), 'Evidence-tamper failure was not explicit');
    git(outputTwo, ['reset', '--hard', '--quiet', originalOutputTwoHead]);

    const originalReleaseTag = git(sourceBare, ['rev-parse', 'refs/tags/v2.0.0']).stdout.trim();
    git(sourceBare, ['update-ref', 'refs/tags/v2.0.0', 'refs/heads/master']);
    const driftWork = path.join(root, 'failure-drift-work');
    const driftOutput = path.join(root, 'failure-drift-output');
    const driftFailure = runNode(
      importer,
      ['--manifest', manifestPath, '--base', base, '--workdir', driftWork, '--output', driftOutput],
      false,
    );
    assert(driftFailure.includes('Tag object drifted'), 'Existing-tag drift failure was not explicit');
    assert(await pathExists(driftWork), 'Existing-tag drift did not preserve workdir');
    assert(!(await pathExists(driftOutput)), 'Existing-tag drift unexpectedly assembled target output');
    git(sourceBare, ['update-ref', 'refs/tags/v2.0.0', originalReleaseTag]);

    git(targetBare, ['update-ref', 'refs/tags/preexisting', base]);
    const targetTagWork = path.join(root, 'failure-target-tag-work');
    const targetTagOutput = path.join(root, 'failure-target-tag-output');
    const targetTagFailure = runNode(
      importer,
      ['--manifest', manifestPath, '--base', base, '--workdir', targetTagWork, '--output', targetTagOutput],
      false,
    );
    assert(targetTagFailure.includes('Target already has tags'), 'Target-tag collision failure was not explicit');
    assert(await pathExists(targetTagWork), 'Target-tag collision did not preserve workdir');
    assert(await pathExists(targetTagOutput), 'Target-tag collision did not preserve partial output');
    git(targetBare, ['update-ref', '-d', 'refs/tags/preexisting']);

    git(targetBare, ['update-ref', 'refs/heads/extra', base]);
    const targetRefFailure = runNode(importer, [
      '--manifest', manifestPath,
      '--base', base,
      '--workdir', path.join(root, 'failure-target-ref-work'),
      '--output', path.join(root, 'failure-target-ref-output'),
    ], false);
    assert(targetRefFailure.includes('Target pre-import ref set differs'), 'Target-ref failure was not explicit');
    git(targetBare, ['update-ref', '-d', 'refs/heads/extra']);

    await mkdir(path.join(targetWork, 'migration', 'evidence'), { recursive: true });
    await writeFile(path.join(targetWork, 'migration', 'evidence', 'preexisting.txt'), 'reserved\n');
    const reservedBase = commit(targetWork, 'add reserved evidence path');
    const reservedTarget = path.join(root, 'reserved-target.git');
    git(root, ['clone', '--bare', '--quiet', targetWork, reservedTarget]);
    const reservedManifest = await readJson(manifestPath);
    reservedManifest.target.url = `file://${reservedTarget}`;
    const reservedManifestPath = path.join(root, 'reserved-manifest.json');
    await writeJson(reservedManifestPath, reservedManifest);
    const reservedFailure = runNode(importer, [
      '--manifest', reservedManifestPath,
      '--base', reservedBase,
      '--workdir', path.join(root, 'failure-reserved-work'),
      '--output', path.join(root, 'failure-reserved-output'),
    ], false);
    assert(reservedFailure.includes('reserved evidence paths'), 'Reserved-path failure was not explicit');

    git(targetWork, ['reset', '--hard', '--quiet', base]);
    await writeFile(path.join(targetWork, 'lib'), 'target file collides with source directory\n');
    const treeCollisionBase = commit(targetWork, 'add file-directory collision');
    const treeCollisionTarget = path.join(root, 'tree-collision-target.git');
    git(root, ['clone', '--bare', '--quiet', targetWork, treeCollisionTarget]);
    const treeCollisionManifest = await readJson(manifestPath);
    treeCollisionManifest.target.url = `file://${treeCollisionTarget}`;
    const treeCollisionManifestPath = path.join(root, 'tree-collision-manifest.json');
    await writeJson(treeCollisionManifestPath, treeCollisionManifest);
    const treeCollisionFailure = runNode(importer, [
      '--manifest', treeCollisionManifestPath,
      '--base', treeCollisionBase,
      '--workdir', path.join(root, 'failure-tree-collision-work'),
      '--output', path.join(root, 'failure-tree-collision-output'),
    ], false);
    assert(treeCollisionFailure.includes('source/target tree collision before merge'), 'Source/target collision failure was not explicit');
    const treeCollisionOutput = path.join(root, 'failure-tree-collision-output');
    assert(git(treeCollisionOutput, ['rev-parse', 'HEAD']).stdout.trim() === treeCollisionBase, 'Tree collision created an import commit');
    assert(!(await pathExists(path.join(treeCollisionOutput, 'migration', 'import-lock.json'))), 'Tree collision created import evidence');

    git(sourceBare, ['update-ref', 'refs/tags/unreviewed', 'refs/heads/master']);
    const tagWork = path.join(root, 'failure-tag-work');
    const tagOutput = path.join(root, 'failure-tag-output');
    const tagFailure = runNode(
      importer,
      ['--manifest', manifestPath, '--base', base, '--workdir', tagWork, '--output', tagOutput],
      false,
    );
    assert(tagFailure.includes('tag set drifted'), 'Added-tag failure was not explicit');
    assert(await pathExists(tagWork), 'Added-tag failure did not preserve workdir');
    assert(!(await pathExists(tagOutput)), 'Added-tag failure unexpectedly assembled target output');
    git(sourceBare, ['update-ref', '-d', 'refs/tags/unreviewed']);

    const collisionManifest = await readJson(manifestPath);
    collisionManifest.sources[0].moves[0].to = 'lib/index.js';
    const collisionManifestPath = path.join(root, 'collision-manifest.json');
    await writeJson(collisionManifestPath, collisionManifest);
    const collisionWork = path.join(root, 'failure-move-work');
    const collisionOutput = path.join(root, 'failure-move-output');
    const collisionFailure = runNode(
      importer,
      ['--manifest', collisionManifestPath, '--base', base, '--workdir', collisionWork, '--output', collisionOutput],
      false,
    );
    assert(collisionFailure.includes('Move target already exists'), 'Move-collision failure was not explicit');
    assert(await pathExists(collisionWork), 'Move-collision failure did not preserve workdir');
    assert(await pathExists(collisionOutput), 'Move-collision failure did not preserve partial output');

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
