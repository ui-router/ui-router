#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  catFileBatch,
  commitTimestamp,
  executionToolchain,
  fail,
  filterRepoVersion,
  generatedCommitEnv,
  git,
  isObjectId,
  pathExists,
  readJson,
  runFilterRepo,
  sha256File,
  validateLocalSourceMetadata,
  validateManifest,
  validatePinnedSource,
  writeJson,
} from './history-migration-lib.mjs';

function usage() {
  return `Usage: node tools/import-history.mjs --base <commit> --output <directory> [options]

Options:
  --manifest <file>    Source manifest (default: migration/sources.json)
  --workdir <dir>      New work directory for filtered source clones
  --source-root <dir>  Optional directory containing validated <source-name>.git mirrors
  --keep-workdir       Keep the work directory after a successful run
  --base <commit>      Required immutable commit from the target repository
  --output <dir>       Required new directory for the assembled repository
  --help               Show this help
`;
}

function parseArgs(argv) {
  const options = {
    manifest: path.resolve('migration/sources.json'),
    keepWorkdir: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--keep-workdir') {
      options.keepWorkdir = true;
      continue;
    }
    if (['--manifest', '--workdir', '--source-root', '--base', '--output'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      options[argument === '--source-root' ? 'sourceRoot' : argument.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (!options.base) fail('--base is required');
  if (!isObjectId(options.base)) fail('--base must be a full 40-character lowercase commit ID');
  if (!options.output) fail('--output is required');
  options.output = path.resolve(options.output);
  if (options.workdir) options.workdir = path.resolve(options.workdir);
  if (options.sourceRoot) options.sourceRoot = path.resolve(options.sourceRoot);
  options.manifest = path.resolve(options.manifest);
  return options;
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

async function prepareSource(source, workdir, filterRepo, sourceRoot) {
  const repository = path.join(workdir, `${source.name}.git`);
  const sourceLocation = sourceRoot ? path.join(sourceRoot, `${source.name}.git`) : source.url;
  if (sourceRoot && !(await pathExists(sourceLocation))) fail(`Source mirror is missing: ${sourceLocation}`);
  validateLocalSourceMetadata(sourceLocation, source.name);
  console.log(`\n[${source.name}] cloning and validating ${sourceLocation}`);
  git(process.cwd(), ['clone', '--mirror', sourceLocation, repository]);

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

async function assembleTarget(manifest, manifestPath, options, preparedSources, versions, workdir) {
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
  const reservedPaths = git(options.output, [
    'ls-tree', '-r', '--name-only', options.base, '--', 'migration/import-lock.json', 'migration/evidence',
  ]).stdout.split('\n').filter(Boolean);
  if (reservedPaths.length > 0) fail(`Target base already uses reserved evidence paths: ${reservedPaths.join(', ')}`);
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

  const evidenceRoot = path.join(options.output, 'migration', 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  for (const source of manifest.sources) {
    const prepared = preparedSources.get(source.name);
    const sourceEvidence = path.join(evidenceRoot, source.name);
    await mkdir(sourceEvidence, { recursive: true });
    await writeFileNormalized(path.join(sourceEvidence, 'commit-map'), prepared.commitMapContents);
    await writeJson(path.join(sourceEvidence, 'refs.json'), {
      sourceHead: source.defaultHead,
      rewrittenHead: prepared.rewrittenHead,
      tags: prepared.tags,
    });
  }

  const lock = {
    schemaVersion: 1,
    manifest: path.basename(manifestPath),
    manifestSha256: await sha256File(manifestPath),
    targetBaseCommit: options.base,
    targetRefsBeforeImport,
    outputBranch: manifest.target.outputBranch,
    tools: versions,
    imports: importResults,
  };
  await writeJson(path.join(options.output, 'migration', 'import-lock.json'), lock);
  await writeJson(path.join(evidenceRoot, 'summary.json'), {
    baseCommit: options.base,
    manifestSha256: lock.manifestSha256,
    imports: importResults,
  });

  git(options.output, ['add', '--', 'migration/import-lock.json', 'migration/evidence']);
  const evidenceTimestamp = commitTimestamp(options.output, 'HEAD') + 1;
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
  console.log(`Run the verifier before pushing: node tools/verify-history.mjs --repo ${options.output} --manifest ${manifestPath}`);
  return { finalHead, evidenceCommit, workdir };
}

async function writeFileNormalized(filename, contents) {
  await mkdir(path.dirname(filename), { recursive: true });
  const normalized = contents.endsWith('\n') ? contents : `${contents}\n`;
  await writeFile(filename, normalized);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.workdir && (pathsOverlap(options.workdir, options.output) || pathsOverlap(options.output, options.workdir))) {
    fail('--workdir and --output must not be equal, nested, or otherwise overlap');
  }
  if (!(await pathExists(options.manifest))) fail(`Manifest does not exist: ${options.manifest}`);
  if (await pathExists(options.output)) fail(`Output path already exists: ${options.output}`);
  if (options.workdir && await pathExists(options.workdir)) fail(`Work path already exists: ${options.workdir}`);

  const manifest = validateManifest(await readJson(options.manifest));
  const filterRepo = filterRepoVersion();
  const versions = executionToolchain(filterRepo);
  if (JSON.stringify(versions) !== JSON.stringify(manifest.historyToolchain)) {
    fail(
      `History toolchain mismatch:\nexpected ${JSON.stringify(manifest.historyToolchain)}\n`
      + `observed ${JSON.stringify(versions)}`,
    );
  }
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
    for (const source of manifest.sources) {
      preparedSources.set(source.name, await prepareSource(source, workdir, filterRepo, options.sourceRoot));
    }
    await assembleTarget(manifest, options.manifest, options, preparedSources, versions, workdir);
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
