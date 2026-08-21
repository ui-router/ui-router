#!/usr/bin/env node

import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  commitHasSignature,
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

async function createFixture(root) {
  const targetWork = path.join(root, 'target-work');
  const targetBare = path.join(root, 'target.git');
  await mkdir(targetWork);
  git(targetWork, ['init', '-b', 'main', '--quiet']);
  await writeFile(path.join(targetWork, 'README.md'), '# target\n');
  const base = commit(targetWork, 'initial target');
  git(root, ['clone', '--bare', '--quiet', targetWork, targetBare]);

  const sourceWork = path.join(root, 'source-work');
  const sourceBare = path.join(root, 'source.git');
  await mkdir(sourceWork);
  git(sourceWork, ['init', '-b', 'master', '--quiet']);
  await mkdir(path.join(sourceWork, 'integration'));
  await writeFile(path.join(sourceWork, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(sourceWork, 'index.js'), 'one\n');
  await writeFile(path.join(sourceWork, 'integration', 'test.txt'), 'fixture\n');
  commit(sourceWork, 'release one');
  git(sourceWork, ['tag', '1.0.0']);

  await writeFile(path.join(sourceWork, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
  await writeFile(path.join(sourceWork, 'index.js'), 'one\ntwo\n');
  const head = commit(sourceWork, 'release two');
  git(sourceWork, ['tag', '-a', 'v2.0.0', '-m', 'release two'], {
    env: generatedCommitEnv(identity, timestamp),
  });
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
    signedDefaultBranchCommitCount: 0,
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
    historyToolchain: {
      gitFilterRepoPackageVersion: '2.47.0',
      gitFilterRepoReportedVersion: 'a40bce548d2c',
    },
    generatedCommitIdentity: identity,
    tagPolicy: { description: 'fixture', renamedFormat: '<source-name>@<original-tag>' },
    sources: [source],
  };
  const manifestPath = path.join(root, 'manifest.json');
  await writeJson(manifestPath, manifest);
  return { base, manifestPath, sourceBare };
}

async function main() {
  const version = filterRepoVersion();
  assert(version.version === 'a40bce548d2c', `Expected git-filter-repo 2.47.0/a40bce548d2c, got ${version.version}`);
  const root = await mkdtemp(path.join(os.tmpdir(), 'uirouter-history-test-'));
  let succeeded = false;
  try {
    const { base, manifestPath, sourceBare } = await createFixture(root);
    const outputOne = path.join(root, 'output-1');
    const outputTwo = path.join(root, 'output-2');
    for (const output of [outputOne, outputTwo]) {
      runNode(importer, ['--manifest', manifestPath, '--base', base, '--output', output]);
    }
    assert(git(outputOne, ['rev-parse', 'HEAD']).stdout === git(outputTwo, ['rev-parse', 'HEAD']).stdout, 'Final HEAD differs');
    assert(git(outputOne, ['show-ref', '--tags']).stdout === git(outputTwo, ['show-ref', '--tags']).stdout, 'Tag refs differ');
    assert(
      await readFile(path.join(outputOne, 'migration/evidence/fixture/commit-map'), 'utf8')
        === await readFile(path.join(outputTwo, 'migration/evidence/fixture/commit-map'), 'utf8'),
      'Commit maps differ',
    );
    await access(path.join(outputOne, 'integration/test.txt'));
    assert(!(await pathExists(path.join(outputOne, 'lib/integration'))), 'Layout source still exists');
    assert(git(outputOne, ['show', 'fixture@1.5.0:lib/tag-only.txt']).stdout === 'tag only\n', 'Tag-only history missing');
    assert(!(await pathExists(path.join(outputOne, 'lib/tag-only.txt'))), 'Tag-only file leaked onto current branch');

    const report = path.join(root, 'verification.json');
    runNode(verifier, ['--repo', outputOne, '--manifest', manifestPath, '--report', report]);
    assert((await readJson(report)).ok === true, 'Verifier report did not pass');

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
