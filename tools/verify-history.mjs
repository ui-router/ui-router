#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  catFileBatch,
  commitTimestamp,
  fail,
  git,
  gitBlobBuffer,
  isObjectId,
  pathExists,
  readJson,
  sha256Buffer,
  sha256File,
  validateLocalSourceMetadata,
  validateManifest,
  validateManifestImmutable,
  validatePinnedSource,
  writeJson,
} from './history-migration-lib.mjs';
import {
  controlFileDefinitions,
  lockedFilterRepoDescriptor,
  validateControlContracts,
  validateExecutionLockInputs,
  validateExecutionLockPreflight,
  validateImportLock,
} from './control-contract-lib.mjs';

const ZERO_OBJECT = '0'.repeat(40);

function usage() {
  return `Usage: node tools/verify-history.mjs --repo <directory> [options]

Options:
  --manifest <file>         Exact assembled migration/sources.json
  --execution-lock <file>   Exact assembled migration/execution-lock.json
  --execution-lock-sha256 <reviewed-digest>
  --control-root <dir>      Reviewed control checkout and retained artifact root
  --source-mode <mode>      remote, mirror, or bundle
  --workdir <dir>           New work directory for verification source clones
  --report <file>           Write a JSON verification report outside the repository
  --keep-workdir            Keep the work directory after a successful verification
  --fixture                 Enable the one-source local fixture domain
  --repo <directory>        Required assembled repository to verify
  --help                    Show this help
`;
}

function parseArgs(argv) {
  const options = { fixture: false, keepWorkdir: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--keep-workdir') {
      options.keepWorkdir = true;
      continue;
    }
    if (argument === '--fixture') {
      options.fixture = true;
      continue;
    }
    if (['--manifest', '--execution-lock', '--execution-lock-sha256', '--control-root', '--source-mode', '--workdir', '--report', '--repo'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      const key = argument.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = ['sourceMode', 'executionLockSha256'].includes(key) ? value : path.resolve(value);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  for (const required of ['repo', 'manifest', 'executionLock', 'executionLockSha256', 'controlRoot', 'sourceMode']) {
    if (!options[required]) fail(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  if (!['remote', 'mirror', 'bundle'].includes(options.sourceMode)) fail('--source-mode must be remote, mirror, or bundle');
  if (!/^[0-9a-f]{64}$/.test(options.executionLockSha256)) {
    fail('--execution-lock-sha256 must be a SHA-256 digest');
  }
  return options;
}

function pathWithin(root, candidate) {
  const relation = path.relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation));
}

async function prospectiveRealpath(filename) {
  const suffix = [];
  let current = path.resolve(filename);
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not resolve parent for ${filename}`);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(await realpath(current), ...suffix);
}

function parseCommitMap(contents, sourceName) {
  const map = new Map();
  for (const line of contents.split('\n')) {
    if (!line || line.startsWith('old ')) continue;
    const [oldCommit, newCommit] = line.trim().split(/\s+/);
    if (!isObjectId(oldCommit) || !isObjectId(newCommit)) fail(`${sourceName} has malformed commit-map data`);
    if (map.has(oldCommit)) fail(`${sourceName} repeats ${oldCommit} in commit-map`);
    map.set(oldCommit, newCommit);
  }
  return map;
}

function parseGitObject(contents) {
  const separator = contents.indexOf(Buffer.from('\n\n'));
  if (separator < 0) fail('Malformed Git object without a header separator');
  const headerText = contents.subarray(0, separator).toString('utf8');
  const headers = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ')) {
      if (headers.length === 0) fail('Malformed Git continuation header');
      headers[headers.length - 1].value += `\n${line}`;
      continue;
    }
    const space = line.indexOf(' ');
    if (space < 1) fail(`Malformed Git header: ${line}`);
    headers.push({ key: line.slice(0, space), value: line.slice(space + 1) });
  }
  return { headers, message: contents.subarray(separator + 2) };
}

function headerValues(parsed, key) {
  return parsed.headers.filter((header) => header.key === key).map((header) => header.value);
}

function onlyHeader(parsed, key) {
  const values = headerValues(parsed, key);
  if (values.length !== 1) fail(`Expected exactly one ${key} header`);
  return values[0];
}

function compareBuffers(left, right, label) {
  if (!left.equals(right)) fail(`${label} differs`);
}

function prefixedTreeObjectId(sourceTree, prefix) {
  let current = sourceTree;
  for (const component of prefix.split('/').reverse()) {
    const treeEntry = Buffer.concat([
      Buffer.from(`40000 ${component}\0`),
      Buffer.from(current, 'hex'),
    ]);
    current = createHash('sha1')
      .update(Buffer.from(`tree ${treeEntry.length}\0`))
      .update(treeEntry)
      .digest('hex');
  }
  return current;
}

function refSnapshot(repository) {
  return git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout
    .split('\n')
    .filter(Boolean)
    .sort();
}

function treeEntries(repository, commit) {
  const output = git(repository, ['ls-tree', '-rz', '--full-tree', commit]).stdout;
  const entries = new Map();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) fail(`Malformed ls-tree record at ${commit}`);
    const metadata = record.slice(0, tab);
    const filename = record.slice(tab + 1);
    if (entries.has(filename)) fail(`Duplicate tree path at ${commit}: ${filename}`);
    entries.set(filename, metadata);
  }
  return entries;
}

function compareTreeMaps(expected, actual, label) {
  if (expected.size !== actual.size) fail(`${label} path count differs: ${expected.size} != ${actual.size}`);
  for (const [filename, metadata] of expected) {
    if (actual.get(filename) !== metadata) fail(`${label} differs at ${filename}`);
  }
}

function stripPrefix(entries, prefix, label) {
  const stripped = new Map();
  const requiredPrefix = `${prefix}/`;
  for (const [filename, metadata] of entries) {
    if (!filename.startsWith(requiredPrefix)) fail(`${label} contains a path outside ${prefix}: ${filename}`);
    stripped.set(filename.slice(requiredPrefix.length), metadata);
  }
  return stripped;
}

function transformMoves(entries, moves, label) {
  const transformed = new Map();
  const matchCounts = new Map(moves.map((move) => [move.from, 0]));
  for (const [filename, metadata] of entries) {
    let target = filename;
    for (const move of moves) {
      if (filename === move.from || filename.startsWith(`${move.from}/`)) {
        target = `${move.to}${filename.slice(move.from.length)}`;
        matchCounts.set(move.from, matchCounts.get(move.from) + 1);
        break;
      }
    }
    if (transformed.has(target)) fail(`${label} move collision at ${target}`);
    transformed.set(target, metadata);
  }
  for (const [moveSource, count] of matchCounts) {
    if (count === 0) fail(`${label} move matched no paths: ${moveSource}`);
  }
  return transformed;
}

function unionTrees(first, second, label) {
  const union = new Map(first);
  for (const [filename, metadata] of second) {
    if (union.has(filename)) fail(`${label} merge parents collide at ${filename}`);
    union.set(filename, metadata);
  }
  return union;
}

function commitParents(repository, commit) {
  return git(repository, ['show', '-s', '--format=%P', commit]).stdout.trim().split(' ').filter(Boolean);
}

function verifyGeneratedCommit(repository, commit, expectedParents, identity, expectedTimestamp, expectedMessage) {
  const object = catFileBatch(repository, [commit]).get(commit);
  if (object.objectType !== 'commit') fail(`${commit} is not a commit`);
  const parsed = parseGitObject(object.contents);
  const parents = headerValues(parsed, 'parent');
  if (JSON.stringify(parents) !== JSON.stringify(expectedParents)) fail(`${commit} has unexpected parents`);
  const expectedIdentity = `${identity.name} <${identity.email}> ${expectedTimestamp} +0000`;
  if (onlyHeader(parsed, 'author') !== expectedIdentity || onlyHeader(parsed, 'committer') !== expectedIdentity) {
    fail(`${commit} has non-deterministic generated identity or timestamp`);
  }
  compareBuffers(parsed.message, Buffer.from(`${expectedMessage}\n`), `${commit} message`);
  if (headerValues(parsed, 'gpgsig').length > 0 || headerValues(parsed, 'gpgsig-sha256').length > 0) {
    fail(`${commit} must not claim a source signature`);
  }
}

function verifyRewrittenCommitMetadata(sourceRepository, targetRepository, expectedOldCommits, commitMap, source) {
  const oldObjects = catFileBatch(sourceRepository, expectedOldCommits);
  const newIds = expectedOldCommits.map((oldCommit) => commitMap.get(oldCommit));
  const newObjects = catFileBatch(targetRepository, newIds);
  const newIdSet = new Set(newIds);
  if (newIdSet.size !== newIds.length) fail(`${source.name} commit map is not one-to-one`);

  let signedDefaultCommits = 0;
  const defaultCommits = new Set(
    git(sourceRepository, ['rev-list', source.defaultHead]).stdout.split('\n').filter(Boolean),
  );
  for (const oldCommit of expectedOldCommits) {
    const newCommit = commitMap.get(oldCommit);
    const oldObject = oldObjects.get(oldCommit);
    const newObject = newObjects.get(newCommit);
    if (oldObject.objectType !== 'commit' || newObject.objectType !== 'commit') {
      fail(`${source.name} commit map references a non-commit object`);
    }
    const oldParsed = parseGitObject(oldObject.contents);
    const newParsed = parseGitObject(newObject.contents);
    const expectedHeaders = [];
    for (const header of oldParsed.headers) {
      if (header.key === 'tree') {
        expectedHeaders.push({
          key: 'tree',
          value: prefixedTreeObjectId(header.value, source.destinationPrefix),
        });
      } else if (header.key === 'parent') {
        const mapped = commitMap.get(header.value);
        if (!mapped || mapped === ZERO_OBJECT) fail(`${source.name} did not map parent ${header.value}`);
        expectedHeaders.push({ key: 'parent', value: mapped });
      } else if (!['gpgsig', 'gpgsig-sha256'].includes(header.key)) {
        expectedHeaders.push(header);
      }
    }
    if (JSON.stringify(newParsed.headers) !== JSON.stringify(expectedHeaders)) {
      fail(`${source.name} full commit headers or prefixed tree differ at ${oldCommit}`);
    }
    compareBuffers(oldParsed.message, newParsed.message, `${source.name} commit message at ${oldCommit}`);
    const oldSigned = headerValues(oldParsed, 'gpgsig').length > 0 || headerValues(oldParsed, 'gpgsig-sha256').length > 0;
    if (defaultCommits.has(oldCommit) && oldSigned) signedDefaultCommits += 1;
    if (headerValues(newParsed, 'gpgsig').length > 0 || headerValues(newParsed, 'gpgsig-sha256').length > 0) {
      fail(`${source.name} rewritten commit ${newCommit} must not retain an invalid signature`);
    }
  }
  if (signedDefaultCommits !== source.signedDefaultBranchCommitCount) {
    fail(`${source.name} signature-bearing default commit count differs`);
  }
}

function splitTagSignature(message) {
  const marker = Buffer.from('-----BEGIN PGP SIGNATURE-----');
  const markerOffset = message.indexOf(marker);
  if (markerOffset < 0) return { unsignedMessage: message, signed: false };
  return { unsignedMessage: message.subarray(0, markerOffset), signed: true };
}

function verifyAnnotatedTag(sourceRepository, targetRepository, sourceTag, targetTag, expectedRewrittenCommit) {
  const sourceObject = catFileBatch(sourceRepository, [sourceTag.objectId]).get(sourceTag.objectId);
  const targetObjectId = git(targetRepository, ['rev-parse', `refs/tags/${targetTag}`]).stdout.trim();
  const targetObject = catFileBatch(targetRepository, [targetObjectId]).get(targetObjectId);
  if (sourceObject.objectType !== 'tag' || targetObject.objectType !== 'tag') {
    fail(`${targetTag} did not preserve annotated-tag type`);
  }
  const sourceParsed = parseGitObject(sourceObject.contents);
  const targetParsed = parseGitObject(targetObject.contents);
  if (onlyHeader(sourceParsed, 'object') !== sourceTag.targetCommit
    || onlyHeader(sourceParsed, 'type') !== 'commit'
    || onlyHeader(sourceParsed, 'tag') !== sourceTag.name) {
    fail(`${sourceTag.name} source annotation has an unexpected direct target or name`);
  }
  if (onlyHeader(targetParsed, 'object') !== expectedRewrittenCommit
    || onlyHeader(targetParsed, 'type') !== 'commit'
    || onlyHeader(targetParsed, 'tag') !== targetTag) {
    fail(`${targetTag} annotation has the wrong direct target, type, or name`);
  }
  const expectedHeaders = sourceParsed.headers.map((header) => {
    if (header.key === 'object') return { key: 'object', value: expectedRewrittenCommit };
    if (header.key === 'tag') return { key: 'tag', value: targetTag };
    return header;
  });
  if (JSON.stringify(targetParsed.headers) !== JSON.stringify(expectedHeaders)) {
    fail(`${targetTag} ordered non-signature tag headers differ`);
  }
  const sourceMessage = splitTagSignature(sourceParsed.message);
  const targetMessage = splitTagSignature(targetParsed.message);
  if (sourceMessage.signed !== sourceTag.tagObjectSigned) fail(`${sourceTag.name} signature evidence differs`);
  if (targetMessage.signed) fail(`${targetTag} retained an invalid armored tag signature`);
  compareBuffers(sourceMessage.unsignedMessage, targetMessage.unsignedMessage, `${targetTag} annotation message`);
}

async function findNestedGit(root, current = root) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const filename = path.join(current, entry.name);
    if (current === root && entry.name === '.git') continue;
    if (entry.name === '.git') fail(`Nested .git entry found: ${path.relative(root, filename)}`);
    if (entry.isDirectory()) await findNestedGit(root, filename);
  }
}

async function clonePinnedSource(source, lockedSource, workdir, options) {
  const repository = path.join(workdir, `${source.name}.git`);
  const sourceLocation = options.sourceMode === 'remote'
    ? source.url
    : path.join(options.controlRoot, options.sourceMode === 'mirror' ? lockedSource.mirrorPath : lockedSource.bundlePath);
  if (options.sourceMode !== 'remote' && !(await pathExists(sourceLocation))) {
    fail(`${source.name} ${options.sourceMode} source is missing: ${sourceLocation}`);
  }
  validateLocalSourceMetadata(sourceLocation, source.name);
  console.log(`[${source.name}] cloning ${options.sourceMode} source for independent verification`);
  git(process.cwd(), ['clone', '--mirror', sourceLocation, repository]);
  validatePinnedSource(repository, source);
  return repository;
}

async function verifySource(source, sourceRepository, targetRepository, importRecord) {
  const evidenceDirectory = path.join(targetRepository, 'migration', 'evidence', 'imports', source.name);
  const commitMap = parseCommitMap(await readFile(path.join(evidenceDirectory, 'commit-map'), 'utf8'), source.name);
  for (const [oldCommit, newCommit] of commitMap) {
    if (newCommit === ZERO_OBJECT) fail(`${source.name} unexpectedly dropped commit ${oldCommit}`);
  }

  const selectedTips = [source.defaultHead, ...source.releaseTags.map((tag) => tag.targetCommit)];
  const expectedOldCommits = git(sourceRepository, ['rev-list', ...selectedTips]).stdout.split('\n').filter(Boolean);
  const expectedOldSet = new Set(expectedOldCommits);
  if (expectedOldSet.size !== commitMap.size) {
    fail(`${source.name} commit-map size differs from the selected history: ${commitMap.size} != ${expectedOldSet.size}`);
  }
  for (const oldCommit of expectedOldSet) {
    if (!commitMap.has(oldCommit)) fail(`${source.name} commit-map omits ${oldCommit}`);
  }

  const rewrittenHead = commitMap.get(source.defaultHead);
  if (rewrittenHead !== importRecord.rewrittenHead) fail(`${source.name} import lock has the wrong rewritten head`);
  const refsEvidence = await readJson(path.join(evidenceDirectory, 'refs.json'));
  const expectedRefsEvidence = {
    sourceHead: source.defaultHead,
    rewrittenHead,
    tags: source.releaseTags.map((tag) => {
      const targetRef = `refs/tags/${tag.targetName}`;
      return {
        originalName: tag.name,
        targetName: tag.targetName,
        originalObject: tag.objectId,
        originalCommit: tag.targetCommit,
        rewrittenObject: git(targetRepository, ['rev-parse', targetRef]).stdout.trim(),
        rewrittenCommit: git(targetRepository, ['rev-parse', `${targetRef}^{commit}`]).stdout.trim(),
      };
    }),
  };
  if (JSON.stringify(refsEvidence) !== JSON.stringify(expectedRefsEvidence)) {
    fail(`${source.name} refs evidence differs from the manifest/imported refs`);
  }
  if (git(targetRepository, ['merge-base', '--is-ancestor', rewrittenHead, importRecord.mergeCommit], { allowFailure: true }).status !== 0) {
    fail(`${source.name} rewritten head is not a merge parent ancestor`);
  }
  verifyRewrittenCommitMetadata(sourceRepository, targetRepository, expectedOldCommits, commitMap, source);

  const sourceHeadTree = treeEntries(sourceRepository, source.defaultHead);
  const rewrittenHeadTree = stripPrefix(
    treeEntries(targetRepository, rewrittenHead),
    source.destinationPrefix,
    `${source.name} rewritten head`,
  );
  compareTreeMaps(sourceHeadTree, rewrittenHeadTree, `${source.name} rewritten head tree`);

  for (const tag of source.releaseTags) {
    const targetRef = `refs/tags/${tag.targetName}`;
    const targetType = git(targetRepository, ['cat-file', '-t', targetRef]).stdout.trim();
    if (targetType !== tag.objectType) fail(`${tag.targetName} changed tag object type`);
    const targetCommit = git(targetRepository, ['rev-parse', `${targetRef}^{commit}`]).stdout.trim();
    if (targetCommit !== commitMap.get(tag.targetCommit)) fail(`${tag.targetName} points to the wrong rewritten commit`);
    const sourceTree = treeEntries(sourceRepository, tag.targetCommit);
    const targetTree = stripPrefix(
      treeEntries(targetRepository, targetCommit),
      source.destinationPrefix,
      tag.targetName,
    );
    compareTreeMaps(sourceTree, targetTree, `${tag.targetName} tagged tree`);
    if (tag.objectType === 'tag') {
      verifyAnnotatedTag(sourceRepository, targetRepository, tag, tag.targetName, targetCommit);
    }
  }

  return {
    name: source.name,
    selectedCommitCount: expectedOldCommits.length,
    defaultBranchCommitCount: source.defaultBranchCommitCount,
    releaseTagCount: source.releaseTags.length,
    excludedTagCount: source.excludedTags.length,
    signedDefaultBranchCommitCount: source.signedDefaultBranchCommitCount,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!(await pathExists(options.repo))) fail(`Repository does not exist: ${options.repo}`);
  if (!(await pathExists(options.manifest))) fail(`Manifest does not exist: ${options.manifest}`);
  if (options.workdir && await pathExists(options.workdir)) fail(`Work path already exists: ${options.workdir}`);
  const [realRepository, realControlRoot] = await Promise.all([
    realpath(options.repo), realpath(options.controlRoot),
  ]);
  for (const [label, filename] of [['--workdir', options.workdir], ['--report', options.report]]) {
    if (!filename) continue;
    const resolved = await prospectiveRealpath(filename);
    if (pathWithin(realRepository, resolved) || pathWithin(realControlRoot, resolved)) {
      fail(`${label} must be outside the assembled repository and control root`);
    }
  }

  const expectedManifest = path.join(options.repo, 'migration', 'sources.json');
  const expectedExecutionLock = path.join(options.repo, 'migration', 'execution-lock.json');
  if (options.manifest !== expectedManifest) fail('--manifest must be the exact assembled migration/sources.json');
  if (options.executionLock !== expectedExecutionLock) {
    fail('--execution-lock must be the exact assembled migration/execution-lock.json');
  }
  for (const { filename } of controlFileDefinitions()) {
    const assembled = path.join(options.repo, filename);
    const control = path.join(options.controlRoot, filename);
    if (!(await pathExists(assembled)) || !(await pathExists(control))) fail(`Control file is missing: ${filename}`);
    if (await sha256File(assembled) !== await sha256File(control)) fail(`Assembled/control digest differs: ${filename}`);
  }
  if (await sha256File(options.executionLock) !== options.executionLockSha256) {
    fail('Execution lock differs from the separately reviewed digest');
  }
  const manifest = validateManifest(await readJson(options.manifest), { fixture: options.fixture });
  const executionLock = await readJson(options.executionLock);
  const lockPath = path.join(options.repo, 'migration', 'import-lock.json');
  if (!(await pathExists(lockPath))) fail(`Import lock does not exist: ${lockPath}`);
  const lock = await readJson(lockPath);
  await validateExecutionLockPreflight({
    contractRoot: options.repo,
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    expectedBase: executionLock.targetBase,
    fixture: options.fixture,
    requireCommittedControl: !options.fixture,
  });
  await validateControlContracts({
    contractRoot: options.repo,
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    expectedBase: executionLock.targetBase,
    evidenceMode: 'imported',
    fixture: options.fixture,
    validateArtifacts: false,
  });
  await validateExecutionLockInputs({
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    fixture: options.fixture,
    requireCommittedControl: !options.fixture,
  });
  const filterRepo = await lockedFilterRepoDescriptor(options.controlRoot, executionLock);
  await validateImportLock({
    repository: options.repo, importLock: lock, manifest, executionLock,
    controlRoot: options.controlRoot, filterRepo, fixture: options.fixture,
  });
  const summary = await readJson(path.join(options.repo, 'migration/evidence/summary.json'));
  const expectedSummary = {
    schemaVersion: 1,
    baseCommit: lock.targetBaseCommit,
    manifestSha256: lock.manifestSha256,
    executionLockSha256: lock.executionLock.sha256,
    targetRefsBeforeImport: lock.targetRefsBeforeImport,
    outputBranch: lock.outputBranch,
    controlFiles: lock.controlFiles,
    controlEvidence: lock.controlEvidence,
    imports: lock.imports,
  };
  if (JSON.stringify(summary) !== JSON.stringify(expectedSummary)) fail('Summary evidence differs from import lock');
  const expectedEvidenceFiles = [
    ...lock.controlEvidence.map((record) => record.destination),
    ...lock.imports.flatMap((record) => [
      `migration/evidence/imports/${record.name}/commit-map`,
      `migration/evidence/imports/${record.name}/refs.json`,
    ]),
    'migration/evidence/summary.json',
  ].sort();
  const actualEvidenceFiles = git(options.repo, [
    'ls-tree', '-r', '--name-only', 'HEAD', '--', 'migration/evidence',
  ]).stdout.split('\n').filter(Boolean).sort();
  if (JSON.stringify(actualEvidenceFiles) !== JSON.stringify(expectedEvidenceFiles)) {
    fail('Committed evidence tree has missing or unexpected files');
  }
  const leakedControlEvidence = git(options.repo, [
    'ls-tree', '-r', '--name-only', 'HEAD', '--', 'migration/control-evidence',
  ]).stdout.split('\n').filter(Boolean);
  if (leakedControlEvidence.length > 0) fail('Assembled repository contains migration/control-evidence paths');
  if (git(options.repo, ['cat-file', '-t', lock.targetBaseCommit], { allowFailure: true }).stdout.trim() !== 'commit') {
    fail('Import lock target base is not a commit in the assembled repository');
  }
  const baseManifest = gitBlobBuffer(options.repo, lock.targetBaseCommit, 'migration/sources.json');
  if (sha256Buffer(baseManifest) !== executionLock.targetBaseSourceManifestSha256) {
    fail('Target-base migration/sources.json differs from the execution lock');
  }
  const baseManifestJson = validateManifest(JSON.parse(baseManifest.toString('utf8')), { fixture: options.fixture });
  if (!options.fixture) validateManifestImmutable(manifest, baseManifestJson);
  const targetMainRef = `refs/remotes/origin/${manifest.target.baseBranch}`;
  if (git(options.repo, ['rev-parse', targetMainRef]).stdout.trim() !== lock.targetBaseCommit) {
    fail(`Import lock target base does not equal ${targetMainRef}`);
  }
  if (git(options.repo, ['remote', 'get-url', 'origin']).stdout.trim() !== manifest.target.url) {
    fail('Assembled repository origin differs from manifest target.url');
  }
  if (git(options.repo, ['symbolic-ref', '--short', 'HEAD']).stdout.trim() !== manifest.target.outputBranch) {
    fail('Assembled repository is not on the manifest output branch');
  }
  if (git(options.repo, ['status', '--porcelain']).stdout !== '') fail('Assembled repository must be clean before verification');
  await findNestedGit(options.repo);

  const expectedTags = manifest.sources.flatMap((source) => source.releaseTags.map((tag) => tag.targetName)).sort();
  const actualTags = git(options.repo, ['tag', '--list']).stdout.split('\n').filter(Boolean).sort();
  if (JSON.stringify(actualTags) !== JSON.stringify(expectedTags)) fail('Final tag set differs from the manifest');
  const workdir = options.workdir
    ? (await mkdir(options.workdir, { recursive: false }), options.workdir)
    : await mkdtemp(path.join(os.tmpdir(), 'uirouter-history-verify-'));
  let succeeded = false;

  try {
    const reportSources = [];
    let expectedFirstParent = lock.targetBaseCommit;
    for (let index = 0; index < manifest.sources.length; index += 1) {
      const source = manifest.sources[index];
      const importRecord = lock.imports[index];
      if (importRecord.name !== source.name) fail(`Import order differs at index ${index}`);
      if (importRecord.sourceHead !== source.defaultHead) fail(`${source.name} import lock source head differs`);
      if (!isObjectId(importRecord.rewrittenHead) || !isObjectId(importRecord.mergeCommit)
        || (importRecord.layoutCommit !== null && !isObjectId(importRecord.layoutCommit))) {
        fail(`${source.name} import lock has invalid generated object IDs`);
      }
      const sourceRepository = await clonePinnedSource(source, executionLock.sources[index], workdir, options);
      reportSources.push(await verifySource(source, sourceRepository, options.repo, importRecord));

      const mergeParents = commitParents(options.repo, importRecord.mergeCommit);
      if (mergeParents.length !== 2 || mergeParents[0] !== expectedFirstParent || mergeParents[1] !== importRecord.rewrittenHead) {
        fail(`${source.name} merge commit parents differ`);
      }
      const mergeTimestamp = Math.max(
        commitTimestamp(options.repo, mergeParents[0]),
        commitTimestamp(options.repo, mergeParents[1]),
      ) + 1;
      verifyGeneratedCommit(
        options.repo,
        importRecord.mergeCommit,
        mergeParents,
        manifest.generatedCommitIdentity,
        mergeTimestamp,
        `chore: import ${source.name} history`,
      );
      compareTreeMaps(
        unionTrees(
          treeEntries(options.repo, mergeParents[0]),
          treeEntries(options.repo, mergeParents[1]),
          `${source.name} merge`,
        ),
        treeEntries(options.repo, importRecord.mergeCommit),
        `${source.name} merge tree`,
      );

      if (source.moves.length > 0) {
        if (!isObjectId(importRecord.layoutCommit)) fail(`${source.name} layout commit is missing`);
        const layoutParents = commitParents(options.repo, importRecord.layoutCommit);
        if (layoutParents.length !== 1 || layoutParents[0] !== importRecord.mergeCommit) {
          fail(`${source.name} layout commit parent differs`);
        }
        verifyGeneratedCommit(
          options.repo,
          importRecord.layoutCommit,
          layoutParents,
          manifest.generatedCommitIdentity,
          commitTimestamp(options.repo, importRecord.mergeCommit) + 1,
          `chore: place ${source.name} projects in monorepo layout`,
        );
        compareTreeMaps(
          transformMoves(treeEntries(options.repo, importRecord.mergeCommit), source.moves, source.name),
          treeEntries(options.repo, importRecord.layoutCommit),
          `${source.name} pure layout move`,
        );
        expectedFirstParent = importRecord.layoutCommit;
      } else {
        if (importRecord.layoutCommit !== null) fail(`${source.name} has an unexpected layout commit`);
        expectedFirstParent = importRecord.mergeCommit;
      }
    }

    const finalHead = git(options.repo, ['rev-parse', 'HEAD']).stdout.trim();
    const expectedFinalRefs = [
      `refs/heads/${manifest.target.baseBranch} ${lock.targetBaseCommit}`,
      `refs/remotes/origin/HEAD ${lock.targetBaseCommit}`,
      `${targetMainRef} ${lock.targetBaseCommit}`,
    ];
    expectedFinalRefs.push(`refs/heads/${manifest.target.outputBranch} ${finalHead}`);
    for (const tag of manifest.sources.flatMap((source) => source.releaseTags)) {
      expectedFinalRefs.push(
        `refs/tags/${tag.targetName} ${git(options.repo, ['rev-parse', `refs/tags/${tag.targetName}`]).stdout.trim()}`,
      );
    }
    expectedFinalRefs.sort();
    if (JSON.stringify(refSnapshot(options.repo)) !== JSON.stringify(expectedFinalRefs)) {
      fail('Final ref namespace differs from the exact target/import contract');
    }
    const finalParents = commitParents(options.repo, finalHead);
    if (finalParents.length !== 1 || finalParents[0] !== expectedFirstParent) fail('Final evidence commit parent differs');
    verifyGeneratedCommit(
      options.repo,
      finalHead,
      finalParents,
      manifest.generatedCommitIdentity,
      commitTimestamp(options.repo, expectedFirstParent) + 1,
      'chore: record history import evidence',
    );
    const evidenceChanges = git(options.repo, ['diff', '--name-only', expectedFirstParent, finalHead]).stdout
      .split('\n')
      .filter(Boolean)
      .sort();
    const changedControlFiles = lock.controlFiles
      .map((record) => record.destination)
      .filter((filename) => git(options.repo, ['diff', '--quiet', expectedFirstParent, finalHead, '--', filename], {
        allowFailure: true,
      }).status === 1);
    const expectedEvidenceChanges = [
      ...changedControlFiles,
      ...lock.controlEvidence.map((record) => record.destination),
      ...lock.imports.flatMap((record) => [
        `migration/evidence/imports/${record.name}/commit-map`,
        `migration/evidence/imports/${record.name}/refs.json`,
      ]),
      'migration/evidence/summary.json',
      'migration/import-lock.json',
    ].sort();
    if (JSON.stringify(evidenceChanges) !== JSON.stringify(expectedEvidenceChanges)) {
      fail('Final evidence commit contains missing or unexpected paths');
    }

    const report = {
      ok: true,
      sourceManifestSha256: lock.manifestSha256,
      executionLockSha256: lock.executionLock.sha256,
      targetBaseCommit: lock.targetBaseCommit,
      finalHead,
      sourceCount: reportSources.length,
      releaseTagCount: expectedTags.length,
      sources: reportSources,
    };
    if (options.report) await writeJson(options.report, report);
    console.log(`\nVerified ${report.sourceCount} sources and ${report.releaseTagCount} release tags.`);
    console.log(`Final HEAD: ${finalHead}`);
    if (options.report) console.log(`Report: ${options.report}`);
    succeeded = true;
  } finally {
    if (succeeded) {
      if (options.keepWorkdir) console.log(`Kept work directory: ${workdir}`);
      else {
        await rm(workdir, { recursive: true, force: true });
        console.log(`Removed work directory: ${workdir}`);
      }
    } else {
      console.error(`Preserved verification work directory for diagnosis: ${workdir}`);
    }
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
