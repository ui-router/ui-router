#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  commitTimestamp,
  fail,
  filterRepoVersion,
  generatedCommitEnv,
  git,
  gitVersion,
  isObjectId,
  pathExists,
  readJson,
  runFilterRepo,
  sha256File,
  validateManifest,
  writeJson,
} from './history-migration-lib.mjs';

function usage() {
  return `Usage: node tools/import-history.mjs --base <commit> --output <directory> [options]

Options:
  --manifest <file>    Source manifest (default: migration/sources.json)
  --workdir <dir>      New work directory for filtered source clones
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
    if (['--manifest', '--workdir', '--base', '--output'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      options[argument.slice(2)] = value;
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
  options.manifest = path.resolve(options.manifest);
  return options;
}

function parsePackageVersion(repository, commit) {
  const result = git(repository, ['show', `${commit}:package.json`], { allowFailure: true });
  if (result.status !== 0) return null;
  try {
    const packageJson = JSON.parse(result.stdout);
    return typeof packageJson.version === 'string' ? packageJson.version : null;
  } catch {
    return null;
  }
}

function objectHasCommitSignature(repository, commit) {
  const contents = git(repository, ['cat-file', 'commit', commit]).stdout;
  return contents.includes('\ngpgsig ') || contents.startsWith('gpgsig ');
}

function objectHasTagSignature(repository, objectId) {
  return git(repository, ['cat-file', '-p', objectId]).stdout.includes('-----BEGIN PGP SIGNATURE-----');
}

function validateTag(repository, source, tag, included) {
  const label = `${source.name}:${tag.name}`;
  const actualObject = git(repository, ['rev-parse', tag.sourceRef], { allowFailure: true });
  if (actualObject.status !== 0) fail(`Pinned tag is missing: ${label}`);
  if (actualObject.stdout.trim() !== tag.objectId) fail(`Tag object drifted: ${label}`);
  if (git(repository, ['cat-file', '-t', tag.objectId]).stdout.trim() !== tag.objectType) {
    fail(`Tag object type drifted: ${label}`);
  }
  const targetCommit = git(repository, ['rev-parse', `${tag.sourceRef}^{commit}`]).stdout.trim();
  const targetTree = git(repository, ['rev-parse', `${targetCommit}^{tree}`]).stdout.trim();
  if (targetCommit !== tag.targetCommit || targetTree !== tag.targetTree) fail(`Tag target drifted: ${label}`);
  const observedVersion = parsePackageVersion(repository, targetCommit);
  if (observedVersion !== tag.observedRootPackageVersion) fail(`Tag package version drifted: ${label}`);
  const matches = observedVersion === tag.normalizedTagVersion;
  if (matches !== included) fail(`Tag release classification drifted: ${label}`);
  const reachable = git(repository, ['merge-base', '--is-ancestor', targetCommit, source.sourceRef], {
    allowFailure: true,
  }).status === 0;
  if (reachable !== tag.reachableFromDefault) fail(`Tag reachability drifted: ${label}`);
  if (objectHasCommitSignature(repository, targetCommit) !== tag.targetCommitSigned) {
    fail(`Tag target signature presence drifted: ${label}`);
  }
  if (tag.objectType === 'tag' && objectHasTagSignature(repository, tag.objectId) !== tag.tagObjectSigned) {
    fail(`Annotated tag signature presence drifted: ${label}`);
  }
}

function removeUnselectedRefs(repository, allowedRefs) {
  const refs = git(repository, ['for-each-ref', '--format=%(refname)']).stdout.split('\n').filter(Boolean);
  for (const ref of refs) {
    if (!allowedRefs.has(ref)) git(repository, ['update-ref', '-d', ref]);
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

async function prepareSource(source, workdir, filterRepo) {
  const repository = path.join(workdir, `${source.name}.git`);
  console.log(`\n[${source.name}] cloning and validating ${source.url}`);
  git(process.cwd(), ['clone', '--mirror', source.url, repository]);

  const head = git(repository, ['rev-parse', source.sourceRef], { allowFailure: true });
  if (head.status !== 0 || head.stdout.trim() !== source.defaultHead) {
    fail(`${source.name} default head drifted: expected ${source.defaultHead}, got ${head.stdout.trim() || '<missing>'}`);
  }
  const headTree = git(repository, ['rev-parse', `${source.defaultHead}^{tree}`]).stdout.trim();
  if (headTree !== source.defaultHeadTree) fail(`${source.name} default head tree drifted`);
  const commitCount = Number(git(repository, ['rev-list', '--count', source.defaultHead]).stdout.trim());
  if (commitCount !== source.defaultBranchCommitCount) fail(`${source.name} default branch commit count drifted`);

  for (const tag of source.releaseTags) validateTag(repository, source, tag, true);
  for (const tag of source.excludedTags) validateTag(repository, source, tag, false);

  const pinnedTagNames = new Set([...source.releaseTags, ...source.excludedTags].map((tag) => tag.name));
  const observedTagNames = git(repository, ['tag', '--list']).stdout.split('\n').filter(Boolean);
  const extraTags = observedTagNames.filter((tag) => !pinnedTagNames.has(tag));
  if (extraTags.length > 0) {
    console.warn(`[${source.name}] ignoring ${extraTags.length} tags created after the locked snapshot`);
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
    extraTags,
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
  const baseExists = git(options.output, ['cat-file', '-e', `${options.base}^{commit}`], { allowFailure: true });
  if (baseExists.status !== 0) fail(`Target base commit is not present: ${options.base}`);
  const onTargetMain = git(
    options.output,
    ['merge-base', '--is-ancestor', options.base, `refs/remotes/origin/${manifest.target.baseBranch}`],
    { allowFailure: true },
  );
  if (onTargetMain.status !== 0) fail(`Target base is not on origin/${manifest.target.baseBranch}: ${options.base}`);
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
      '+refs/tags/*:refs/tags/*',
    ]);
    const rewrittenRef = `refs/remotes/${remote}/${source.defaultBranch}`;
    const rewrittenHead = git(options.output, ['rev-parse', rewrittenRef]).stdout.trim();
    if (rewrittenHead !== prepared.rewrittenHead) fail(`${source.name} fetched rewritten head drifted`);

    const firstParent = git(options.output, ['rev-parse', 'HEAD']).stdout.trim();
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
    outputBranch: manifest.target.outputBranch,
    tools: {
      node: process.version,
      git: versions.git,
      gitFilterRepo: versions.filterRepo,
    },
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
  if (!(await pathExists(options.manifest))) fail(`Manifest does not exist: ${options.manifest}`);
  if (await pathExists(options.output)) fail(`Output path already exists: ${options.output}`);
  if (options.workdir && await pathExists(options.workdir)) fail(`Work path already exists: ${options.workdir}`);

  const manifest = validateManifest(await readJson(options.manifest));
  const filterRepo = filterRepoVersion();
  if (filterRepo.version !== manifest.historyToolchain.gitFilterRepoReportedVersion) {
    fail(
      `git-filter-repo version mismatch: expected ${manifest.historyToolchain.gitFilterRepoReportedVersion} `
      + `(package ${manifest.historyToolchain.gitFilterRepoPackageVersion}), got ${filterRepo.version}`,
    );
  }
  const versions = { git: gitVersion(), filterRepo: filterRepo.version };
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
      preparedSources.set(source.name, await prepareSource(source, workdir, filterRepo));
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
