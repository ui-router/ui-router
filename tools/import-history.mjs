#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  catFileBatch,
  commitTimestamp,
  fail,
  generatedCommitEnv,
  git,
  gitBlobBuffer,
  isObjectId,
  pathExists,
  prospectiveRealpath,
  readJson,
  runFilterRepo,
  sha256Buffer,
  sha256File,
  validateLocalSourceMetadata,
  validateManifest,
  validateManifestImmutable,
  validatePinnedSource,
  writeJson,
} from './history-migration-lib.mjs';
import {
  buildControlFileRecords,
  copyControlTree,
  lockedFilterRepoDescriptor,
  validateControlContracts,
  validateExecutionLockInputs,
  validateExecutionLockPreflight,
} from './control-contract-lib.mjs';

function usage() {
  return `Usage: node tools/import-history.mjs --base <commit> --output <directory> [options]

Options:
  --manifest <file>         Exact control-root migration/sources.json
  --execution-lock <file>   Exact control-root migration/execution-lock.json
  --execution-lock-sha256 <reviewed-digest>
  --control-root <dir>      Reviewed control checkout and retained artifact root
  --source-mode <mode>      remote, mirror, or bundle
  --workdir <dir>           New work directory for filtered source clones
  --keep-workdir            Keep the work directory after a successful run
  --fixture                 Enable the one-source local fixture domain
  --base <commit>           Required immutable commit from the target repository
  --output <dir>            Required new directory for the assembled repository
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
    if (['--manifest', '--execution-lock', '--execution-lock-sha256', '--control-root', '--source-mode', '--workdir', '--base', '--output'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      options[argument.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  for (const required of ['manifest', 'executionLock', 'executionLockSha256', 'controlRoot', 'sourceMode', 'base', 'output']) {
    if (!options[required]) fail(`--${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  if (!isObjectId(options.base)) fail('--base must be a full 40-character lowercase commit ID');
  if (!/^[0-9a-f]{64}$/.test(options.executionLockSha256)) {
    fail('--execution-lock-sha256 must be a SHA-256 digest');
  }
  if (!['remote', 'mirror', 'bundle'].includes(options.sourceMode)) fail('--source-mode must be remote, mirror, or bundle');
  options.output = path.resolve(options.output);
  if (options.workdir) options.workdir = path.resolve(options.workdir);
  options.manifest = path.resolve(options.manifest);
  options.executionLock = path.resolve(options.executionLock);
  options.controlRoot = path.resolve(options.controlRoot);
  return options;
}

const RESERVED_IMPORT_PATHS = [
  'migration/execution-lock.json',
  'migration/baselines.json',
  'migration/package-classification.json',
  'migration/control-evidence',
  'migration/import-lock.json',
  'migration/evidence',
];

function reservedImportPath(filename) {
  return RESERVED_IMPORT_PATHS.find((reserved) => filename === reserved || filename.startsWith(`${reserved}/`));
}

function pathsOverlap(first, second) {
  const relative = path.relative(first, second);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function removeUnselectedRefs(repository, allowedRefs) {
  const refs = git(repository, ['for-each-ref', '--format=%(refname)']).stdout.split('\n').filter(Boolean);
  for (const ref of refs) {
    if (!allowedRefs.has(ref)) git(repository, ['update-ref', '-d', ref]);
  }
}

function refSnapshot(repository) {
  return git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout
    .split('\n')
    .filter(Boolean)
    .sort();
}

function treeLeafPaths(repository, commit) {
  return git(repository, ['ls-tree', '-r', '--name-only', commit]).stdout.split('\n').filter(Boolean);
}

function firstTreeCollision(firstPaths, secondPaths) {
  const combined = [
    ...firstPaths.map((filename) => ({ filename, owner: 'target' })),
    ...secondPaths.map((filename) => ({ filename, owner: 'source' })),
  ].sort((left, right) => (
    left.filename < right.filename ? -1
      : left.filename > right.filename ? 1
        : left.owner < right.owner ? -1 : 1
  ));
  for (let index = 1; index < combined.length; index += 1) {
    const previous = combined[index - 1];
    const current = combined[index];
    if (previous.owner !== current.owner
      && (previous.filename === current.filename || current.filename.startsWith(`${previous.filename}/`))) {
      return `${previous.filename} <> ${current.filename}`;
    }
  }
  return null;
}

function preflightMove(occupied, currentSourcePaths, move, sourceName) {
  const moving = currentSourcePaths.filter((filename) => (
    filename === move.from || filename.startsWith(`${move.from}/`)
  ));
  if (moving.length === 0) fail(`${sourceName} move source is missing during preflight: ${move.from}`);
  const movingSet = new Set(moving);
  const foreignUnderSource = occupied.filter((filename) => (
    !movingSet.has(filename) && (filename === move.from || filename.startsWith(`${move.from}/`))
  ));
  if (foreignUnderSource.length > 0) fail(`${sourceName} move source overlaps another tree: ${move.from}`);
  const retainedOccupied = occupied.filter((filename) => !movingSet.has(filename));
  if (retainedOccupied.some((filename) => filename === move.to || filename.startsWith(`${move.to}/`))) {
    fail(`${sourceName} move target already exists during preflight: ${move.to}`);
  }
  const retainedSource = currentSourcePaths.filter((filename) => !movingSet.has(filename));
  const moved = moving.map((filename) => `${move.to}${filename.slice(move.from.length)}`);
  const collision = firstTreeCollision(retainedOccupied, moved);
  if (collision) fail(`${sourceName} move collision during preflight: ${collision}`);
  return {
    occupied: [...retainedOccupied, ...moved].sort(),
    currentSourcePaths: [...retainedSource, ...moved].sort(),
  };
}

function preflightAllSourcePaths(targetRepository, base, manifest, preparedSources) {
  let occupied = treeLeafPaths(targetRepository, base).sort();
  for (const source of manifest.sources) {
    const prepared = preparedSources.get(source.name);
    let currentSourcePaths = treeLeafPaths(prepared.repository, prepared.rewrittenHead).sort();
    const initialReserved = currentSourcePaths.find(reservedImportPath);
    if (initialReserved) fail(`${source.name} source uses reserved import path: ${initialReserved}`);
    const collision = firstTreeCollision(occupied, currentSourcePaths);
    if (collision) fail(`${source.name} source/target tree collision before merge: ${collision}`);
    occupied = [...occupied, ...currentSourcePaths].sort();
    for (const move of source.moves) {
      ({ occupied, currentSourcePaths } = preflightMove(occupied, currentSourcePaths, move, source.name));
      const movedReserved = currentSourcePaths.find(reservedImportPath);
      if (movedReserved) fail(`${source.name} move uses reserved import path: ${movedReserved}`);
    }
  }
}

function parseCommitMap(contents) {
  const map = new Map();
  for (const line of contents.split('\n')) {
    if (!line || line.startsWith('old ')) continue;
    const [oldCommit, newCommit] = line.trim().split(/\s+/);
    if (isObjectId(oldCommit) && isObjectId(newCommit)) map.set(oldCommit, newCommit);
  }
  return map;
}

function rewriteAnnotatedTag(repository, originalContents, targetCommit, targetName) {
  const separator = originalContents.indexOf(Buffer.from('\n\n'));
  if (separator < 0) fail(`Malformed annotated tag ${targetName}`);
  const rewrittenHeaders = originalContents.subarray(0, separator).toString('utf8').split('\n').map((line) => {
    if (line.startsWith('object ')) return `object ${targetCommit}`;
    if (line.startsWith('tag ')) return `tag ${targetName}`;
    return line;
  });
  const message = originalContents.subarray(separator + 2);
  const signatureOffset = message.indexOf(Buffer.from('-----BEGIN PGP SIGNATURE-----'));
  const unsignedMessage = signatureOffset < 0 ? message : message.subarray(0, signatureOffset);
  const contents = Buffer.concat([
    Buffer.from(`${rewrittenHeaders.join('\n')}\n\n`),
    unsignedMessage,
  ]);
  const objectId = git(repository, ['hash-object', '-t', 'tag', '-w', '--stdin'], { input: contents }).stdout.trim();
  git(repository, ['update-ref', `refs/tags/${targetName}`, objectId]);
  return objectId;
}

function sourceLocation(source, lockedSource, options) {
  if (options.sourceMode === 'remote') return source.url;
  const relativePath = options.sourceMode === 'mirror' ? lockedSource.mirrorPath : lockedSource.bundlePath;
  return path.join(options.controlRoot, relativePath);
}

async function prepareSource(source, lockedSource, workdir, filterRepo, options) {
  const repository = path.join(workdir, `${source.name}.git`);
  const sourceLocationValue = sourceLocation(source, lockedSource, options);
  if (!(await pathExists(sourceLocationValue)) && options.sourceMode !== 'remote') {
    fail(`${source.name} ${options.sourceMode} source is missing: ${sourceLocationValue}`);
  }
  validateLocalSourceMetadata(sourceLocationValue, source.name);
  console.log(`\n[${source.name}] cloning and validating ${options.sourceMode} source`);
  git(process.cwd(), ['clone', '--mirror', sourceLocationValue, repository]);

  validatePinnedSource(repository, source);
  const annotatedTags = new Map();
  const annotatedTagIds = source.releaseTags.filter((tag) => tag.objectType === 'tag').map((tag) => tag.objectId);
  if (annotatedTagIds.length > 0) {
    const objects = catFileBatch(repository, annotatedTagIds);
    for (const objectId of annotatedTagIds) annotatedTags.set(objectId, objects.get(objectId).contents);
  }

  const allowedRefs = new Set([source.sourceRef, ...source.releaseTags.map((tag) => tag.sourceRef)]);
  removeUnselectedRefs(repository, allowedRefs);
  runFilterRepo(
    filterRepo.command,
    [
      '--force',
      '--preserve-commit-hashes',
      '--to-subdirectory-filter',
      source.destinationPrefix,
      '--tag-rename',
      `:${source.tagNamespace}`,
    ],
    repository,
  );

  const rewrittenHead = git(repository, ['rev-parse', source.sourceRef]).stdout.trim();
  const remainingTags = git(repository, ['tag', '--list']).stdout.split('\n').filter(Boolean).sort();
  const expectedTags = source.releaseTags.map((tag) => tag.targetName).sort();
  if (JSON.stringify(remainingTags) !== JSON.stringify(expectedTags)) {
    fail(`${source.name} filtered tag set does not match the manifest`);
  }

  const gitDirectory = git(repository, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  const commitMapPath = path.join(gitDirectory, 'filter-repo', 'commit-map');
  const commitMapContents = await readFile(commitMapPath, 'utf8');
  const commitMap = parseCommitMap(commitMapContents);
  if (commitMap.get(source.defaultHead) !== rewrittenHead) fail(`${source.name} commit map does not map the default head`);
  for (const tag of source.releaseTags) {
    if (tag.objectType !== 'tag') continue;
    const rewrittenCommit = commitMap.get(tag.targetCommit);
    if (!rewrittenCommit) fail(`${source.name} commit map does not map annotated tag ${tag.name}`);
    rewriteAnnotatedTag(repository, annotatedTags.get(tag.objectId), rewrittenCommit, tag.targetName);
  }

  const tags = source.releaseTags.map((tag) => {
    const rewrittenCommit = git(repository, ['rev-parse', `refs/tags/${tag.targetName}^{commit}`]).stdout.trim();
    if (commitMap.get(tag.targetCommit) !== rewrittenCommit) {
      fail(`${source.name} commit map does not map tag ${tag.name}`);
    }
    return {
      originalName: tag.name,
      targetName: tag.targetName,
      originalObject: tag.objectId,
      originalCommit: tag.targetCommit,
      rewrittenObject: git(repository, ['rev-parse', `refs/tags/${tag.targetName}`]).stdout.trim(),
      rewrittenCommit,
    };
  });

  return {
    repository,
    rewrittenHead,
    commitMapContents,
    tags,
  };
}

function deterministicGitOptions(identity, unixSeconds) {
  return {
    env: generatedCommitEnv(identity, unixSeconds),
  };
}

function createGeneratedCommit(repository, identity, timestamp, message) {
  git(
    repository,
    ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', message],
    deterministicGitOptions(identity, timestamp),
  );
  return git(repository, ['rev-parse', 'HEAD']).stdout.trim();
}

async function assembleTarget(manifest, options, preparedSources, executionLock, controlContract, filterRepo, workdir) {
  console.log(`\n[target] cloning ${manifest.target.url}`);
  git(process.cwd(), ['clone', '--no-checkout', manifest.target.url, options.output]);
  const targetRefsBeforeImport = refSnapshot(options.output);
  const targetTags = targetRefsBeforeImport.filter((record) => record.startsWith('refs/tags/'));
  if (targetTags.length > 0) fail(`Target already has tags: ${targetTags.join(', ')}`);
  const outputRefSuffix = `/${manifest.target.outputBranch}`;
  const outputRefConflicts = targetRefsBeforeImport.filter((record) => record.split(' ')[0].endsWith(outputRefSuffix));
  if (outputRefConflicts.length > 0) {
    fail(`Target output branch already exists: ${outputRefConflicts.join(', ')}`);
  }
  const baseExists = git(options.output, ['cat-file', '-e', options.base], { allowFailure: true });
  if (baseExists.status !== 0) fail(`Target base object is not present: ${options.base}`);
  if (git(options.output, ['cat-file', '-t', options.base]).stdout.trim() !== 'commit') {
    fail(`Target base object is not a commit: ${options.base}`);
  }
  const targetMainRef = `refs/remotes/origin/${manifest.target.baseBranch}`;
  const targetMain = git(options.output, ['rev-parse', targetMainRef]).stdout.trim();
  if (targetMain !== options.base) {
    fail(`Target base must equal ${targetMainRef}: expected ${targetMain}, got ${options.base}`);
  }
  const expectedTargetRefs = [
    `refs/heads/${manifest.target.baseBranch} ${options.base}`,
    `refs/remotes/origin/HEAD ${options.base}`,
    `${targetMainRef} ${options.base}`,
  ].sort();
  if (JSON.stringify(targetRefsBeforeImport) !== JSON.stringify(expectedTargetRefs)) {
    fail('Target pre-import ref set differs from the exact main-only contract');
  }
  const baseManifest = gitBlobBuffer(options.output, options.base, 'migration/sources.json');
  if (sha256Buffer(baseManifest) !== executionLock.targetBaseSourceManifestSha256) {
    fail('Target-base migration/sources.json differs from the execution lock');
  }
  const baseManifestJson = validateManifest(JSON.parse(baseManifest.toString('utf8')), { fixture: options.fixture });
  if (!options.fixture) validateManifestImmutable(manifest, baseManifestJson);
  const reservedPaths = git(options.output, [
    'ls-tree', '-r', '--name-only', options.base, '--',
    'migration/execution-lock.json', 'migration/baselines.json', 'migration/package-classification.json',
    'migration/control-evidence', 'migration/import-lock.json', 'migration/evidence',
  ]).stdout.split('\n').filter(Boolean);
  if (reservedPaths.length > 0) fail(`Target base already uses reserved control/evidence paths: ${reservedPaths.join(', ')}`);
  preflightAllSourcePaths(options.output, options.base, manifest, preparedSources);
  git(options.output, ['checkout', '--detach', options.base]);
  git(options.output, ['switch', '-c', manifest.target.outputBranch]);

  const importResults = [];
  for (const source of manifest.sources) {
    const prepared = preparedSources.get(source.name);
    const remote = `import-${source.name}`;
    console.log(`\n[${source.name}] merging rewritten history`);
    git(options.output, ['remote', 'add', remote, prepared.repository]);
    git(options.output, [
      'fetch',
      '--no-tags',
      remote,
      `+${source.sourceRef}:refs/remotes/${remote}/${source.defaultBranch}`,
      'refs/tags/*:refs/tags/*',
    ]);
    const rewrittenRef = `refs/remotes/${remote}/${source.defaultBranch}`;
    const rewrittenHead = git(options.output, ['rev-parse', rewrittenRef]).stdout.trim();
    if (rewrittenHead !== prepared.rewrittenHead) fail(`${source.name} fetched rewritten head drifted`);

    const firstParent = git(options.output, ['rev-parse', 'HEAD']).stdout.trim();
    const collision = firstTreeCollision(
      treeLeafPaths(options.output, firstParent),
      treeLeafPaths(options.output, rewrittenHead),
    );
    if (collision) fail(`${source.name} source/target tree collision before merge: ${collision}`);
    const mergeTimestamp = Math.max(
      commitTimestamp(options.output, firstParent),
      commitTimestamp(options.output, rewrittenHead),
    ) + 1;
    git(
      options.output,
      [
        '-c', 'commit.gpgSign=false',
        '-c', 'core.hooksPath=/dev/null',
        'merge',
        '--no-ff',
        '--no-gpg-sign',
        '--allow-unrelated-histories',
        '-m', `chore: import ${source.name} history`,
        rewrittenRef,
      ],
      deterministicGitOptions(manifest.generatedCommitIdentity, mergeTimestamp),
    );
    const mergeCommit = git(options.output, ['rev-parse', 'HEAD']).stdout.trim();

    let layoutCommit = null;
    if (source.moves.length > 0) {
      console.log(`[${source.name}] applying ${source.moves.length} explicit layout moves`);
      for (const move of source.moves) {
        if (!(await pathExists(path.join(options.output, move.from)))) fail(`Move source is missing: ${move.from}`);
        if (await pathExists(path.join(options.output, move.to))) fail(`Move target already exists: ${move.to}`);
        await mkdir(path.dirname(path.join(options.output, move.to)), { recursive: true });
        git(options.output, ['mv', '--', move.from, move.to]);
      }
      const layoutTimestamp = commitTimestamp(options.output, mergeCommit) + 1;
      layoutCommit = createGeneratedCommit(
        options.output,
        manifest.generatedCommitIdentity,
        layoutTimestamp,
        `chore: place ${source.name} projects in monorepo layout`,
      );
    }

    git(options.output, ['remote', 'remove', remote]);
    importResults.push({
      name: source.name,
      sourceHead: source.defaultHead,
      rewrittenHead,
      mergeCommit,
      layoutCommit,
      releaseTagCount: source.releaseTags.length,
    });
  }

  const finalControlContract = await validateControlContracts({
    contractRoot: options.controlRoot,
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    filterRepo,
    expectedBase: options.base,
    fixture: options.fixture,
  });
  if (JSON.stringify(finalControlContract.controlFiles) !== JSON.stringify(controlContract.controlFiles)
    || JSON.stringify(finalControlContract.evidence) !== JSON.stringify(controlContract.evidence)) {
    fail('Control contracts or evidence changed during import');
  }
  await copyControlTree({
    controlRoot: options.controlRoot,
    destinationRoot: options.output,
    evidence: controlContract.evidence,
  });
  const importEvidenceRoot = path.join(options.output, 'migration', 'evidence', 'imports');
  for (const source of manifest.sources) {
    const prepared = preparedSources.get(source.name);
    const sourceEvidence = path.join(importEvidenceRoot, source.name);
    await mkdir(sourceEvidence, { recursive: true });
    const commitMap = prepared.commitMapContents.endsWith('\n')
      ? prepared.commitMapContents : `${prepared.commitMapContents}\n`;
    await writeFile(path.join(sourceEvidence, 'commit-map'), commitMap);
    await writeJson(path.join(sourceEvidence, 'refs.json'), {
      sourceHead: source.defaultHead,
      rewrittenHead: prepared.rewrittenHead,
      tags: prepared.tags,
    });
  }

  const evidenceTimestamp = commitTimestamp(options.output, 'HEAD') + 1;
  const lock = {
    schemaVersion: 2,
    manifest: 'migration/sources.json',
    manifestSha256: await sha256File(path.join(options.output, 'migration/sources.json')),
    executionLock: {
      path: 'migration/execution-lock.json',
      sha256: await sha256File(path.join(options.output, 'migration/execution-lock.json')),
    },
    targetBaseCommit: options.base,
    targetRefsBeforeImport,
    outputBranch: manifest.target.outputBranch,
    tools: executionLock.toolchain,
    controlFiles: await buildControlFileRecords(options.output),
    controlEvidence: controlContract.evidence.map((record) => ({
      ownerContract: record.ownerContract,
      source: record.sourcePath,
      destination: record.destinationPath,
      sha256: record.sha256,
    })),
    imports: importResults,
  };
  await writeJson(path.join(options.output, 'migration', 'import-lock.json'), lock);
  await writeJson(path.join(options.output, 'migration', 'evidence', 'summary.json'), {
    schemaVersion: 1,
    baseCommit: lock.targetBaseCommit,
    manifestSha256: lock.manifestSha256,
    executionLockSha256: lock.executionLock.sha256,
    targetRefsBeforeImport: lock.targetRefsBeforeImport,
    outputBranch: lock.outputBranch,
    controlFiles: lock.controlFiles,
    controlEvidence: lock.controlEvidence,
    imports: lock.imports,
  });

  git(options.output, ['add', '--',
    'migration/sources.json', 'migration/execution-lock.json', 'migration/baselines.json',
    'migration/package-classification.json', 'migration/evidence/control', 'migration/evidence/imports',
    'migration/evidence/summary.json', 'migration/import-lock.json',
  ]);
  const evidenceCommit = createGeneratedCommit(
    options.output,
    manifest.generatedCommitIdentity,
    evidenceTimestamp,
    'chore: record history import evidence',
  );

  const finalHead = git(options.output, ['rev-parse', 'HEAD']).stdout.trim();
  console.log(`\nImport complete: ${options.output}`);
  console.log(`Base: ${options.base}`);
  console.log(`Evidence commit: ${evidenceCommit}`);
  console.log(`Final HEAD: ${finalHead}`);
  console.log(`Run the verifier before pushing with the assembled manifest/lock and --control-root ${options.controlRoot}`);
  return { finalHead, evidenceCommit, workdir };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const physicalControlRoot = await prospectiveRealpath(options.controlRoot);
  const physicalOutput = await prospectiveRealpath(options.output);
  const physicalWorkdir = options.workdir ? await prospectiveRealpath(options.workdir) : null;
  if (physicalWorkdir && (pathsOverlap(physicalWorkdir, physicalOutput) || pathsOverlap(physicalOutput, physicalWorkdir))) {
    fail('--workdir and --output must not be equal, nested, or otherwise overlap');
  }
  for (const candidate of [physicalOutput, ...(physicalWorkdir ? [physicalWorkdir] : [])]) {
    if (pathsOverlap(physicalControlRoot, candidate) || pathsOverlap(candidate, physicalControlRoot)) {
      fail('--control-root must not physically overlap --output or --workdir');
    }
  }
  const expectedManifest = path.join(options.controlRoot, 'migration', 'sources.json');
  const expectedExecutionLock = path.join(options.controlRoot, 'migration', 'execution-lock.json');
  if (options.manifest !== expectedManifest) fail('--manifest must be the exact control-root migration/sources.json');
  if (options.executionLock !== expectedExecutionLock) {
    fail('--execution-lock must be the exact control-root migration/execution-lock.json');
  }
  if (!(await pathExists(options.manifest))) fail(`Manifest does not exist: ${options.manifest}`);
  if (!(await pathExists(options.executionLock))) fail(`Execution lock does not exist: ${options.executionLock}`);
  if (await pathExists(options.output)) fail(`Output path already exists: ${options.output}`);
  if (options.workdir && await pathExists(options.workdir)) fail(`Work path already exists: ${options.workdir}`);

  if (await sha256File(options.executionLock) !== options.executionLockSha256) {
    fail('Execution lock differs from the separately reviewed digest');
  }
  const manifest = validateManifest(await readJson(options.manifest), { fixture: options.fixture });
  const executionLock = await readJson(options.executionLock);
  await validateExecutionLockPreflight({
    contractRoot: options.controlRoot,
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    expectedBase: options.base,
    fixture: options.fixture,
    requireCommittedControl: !options.fixture,
  });
  await validateControlContracts({
    contractRoot: options.controlRoot,
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    expectedBase: options.base,
    fixture: options.fixture,
    requireCommittedControl: !options.fixture,
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
  const controlContract = await validateControlContracts({
    contractRoot: options.controlRoot,
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    filterRepo,
    expectedBase: options.base,
    fixture: options.fixture,
    requireCommittedControl: !options.fixture,
  });
  const workdir = options.workdir
    ? (await mkdir(options.workdir, { recursive: false }), options.workdir)
    : await mkdtemp(path.join(os.tmpdir(), 'uirouter-history-import-'));
  let succeeded = false;

  console.log(`Manifest: ${options.manifest}`);
  console.log(`Target base: ${options.base}`);
  console.log(`Work directory: ${workdir}`);
  console.log(`git-filter-repo: ${filterRepo.version}`);

  try {
    const preparedSources = new Map();
    for (const [index, source] of manifest.sources.entries()) {
      preparedSources.set(source.name, await prepareSource(
        source, executionLock.sources[index], workdir, filterRepo, options,
      ));
    }
    await assembleTarget(
      manifest, options, preparedSources, executionLock, controlContract, filterRepo, workdir,
    );
    succeeded = true;
  } finally {
    if (succeeded) {
      if (options.keepWorkdir) console.log(`Kept work directory: ${workdir}`);
      else {
        await rm(workdir, { recursive: true, force: true });
        console.log(`Removed work directory: ${workdir}`);
      }
    } else {
      console.error(`Preserved work directory for diagnosis: ${workdir}`);
      if (await pathExists(options.output)) console.error(`Preserved partial output for diagnosis: ${options.output}`);
    }
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
