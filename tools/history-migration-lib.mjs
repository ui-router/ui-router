import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function fail(message) {
  throw new Error(message);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const rendered = [command, ...args].join(' ');
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`Command failed (${result.status}): ${rendered}${detail ? `\n${detail}` : ''}`);
  }

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function git(cwd, args, options = {}) {
  return run('git', args, { ...options, cwd });
}

export function catFileBatch(cwd, objectIds) {
  const objects = new Map();
  const chunkSize = 1000;
  for (let offset = 0; offset < objectIds.length; offset += chunkSize) {
    const chunk = objectIds.slice(offset, offset + chunkSize);
    const result = spawnSync('git', ['cat-file', '--batch'], {
      cwd,
      input: `${chunk.join('\n')}\n`,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      fail(`git cat-file --batch failed (${result.status}): ${result.stderr.toString('utf8').trim()}`);
    }
    let position = 0;
    for (const requestedId of chunk) {
      const headerEnd = result.stdout.indexOf(0x0a, position);
      if (headerEnd < 0) fail(`Malformed cat-file output for ${requestedId}`);
      const header = result.stdout.subarray(position, headerEnd).toString('utf8');
      const [objectId, objectType, sizeText] = header.split(' ');
      if (objectType === 'missing') fail(`Missing Git object: ${requestedId}`);
      const size = Number(sizeText);
      if (!Number.isInteger(size) || size < 0) fail(`Malformed cat-file size for ${requestedId}`);
      const contentStart = headerEnd + 1;
      const contentEnd = contentStart + size;
      if (contentEnd >= result.stdout.length || result.stdout[contentEnd] !== 0x0a) {
        fail(`Malformed cat-file content for ${requestedId}`);
      }
      objects.set(requestedId, {
        objectId,
        objectType,
        contents: result.stdout.subarray(contentStart, contentEnd),
      });
      position = contentEnd + 1;
    }
  }
  return objects;
}

export async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

export async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

export async function pathExists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function sha256File(filename) {
  return createHash('sha256').update(await readFile(filename)).digest('hex');
}

export function isObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function assertRepoPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  if (value.includes('\\')) fail(`${label} must use forward slashes: ${value}`);
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    fail(`${label} must be a normalized repository-relative path: ${value}`);
  }
  if (value === '.' || value.split('/').includes('..')) fail(`${label} is unsafe: ${value}`);
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) fail('Manifest schemaVersion must be 1');
  if (!manifest.target || typeof manifest.target.url !== 'string') fail('Manifest target.url is required');
  if (typeof manifest.target.baseBranch !== 'string') fail('Manifest target.baseBranch is required');
  if (manifest.target.baseCommit !== null) fail('Manifest target.baseCommit must remain null; --base supplies the immutable execution input');
  if (typeof manifest.target.outputBranch !== 'string') fail('Manifest target.outputBranch is required');
  if (!manifest.historyToolchain?.gitFilterRepoPackageVersion || !manifest.historyToolchain?.gitFilterRepoReportedVersion) {
    fail('Manifest historyToolchain git-filter-repo versions are required');
  }
  if (!manifest.generatedCommitIdentity?.name || !manifest.generatedCommitIdentity?.email) {
    fail('Manifest generatedCommitIdentity name and email are required');
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) fail('Manifest sources must be non-empty');

  const sourceNames = new Set();
  const prefixes = new Set();
  const targetTags = new Set();
  for (const [sourceIndex, source] of manifest.sources.entries()) {
    const label = `sources[${sourceIndex}]`;
    if (typeof source.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(source.name)) {
      fail(`${label}.name is invalid`);
    }
    if (sourceNames.has(source.name)) fail(`Duplicate source name: ${source.name}`);
    sourceNames.add(source.name);
    if (typeof source.url !== 'string' || source.url.length === 0) fail(`${label}.url is required`);
    if (typeof source.defaultBranch !== 'string' || source.defaultBranch.length === 0) fail(`${label}.defaultBranch is required`);
    if (source.sourceRef !== `refs/heads/${source.defaultBranch}`) fail(`${label}.sourceRef must match defaultBranch`);
    if (!isObjectId(source.defaultHead) || !isObjectId(source.defaultHeadTree)) fail(`${label} has invalid head/tree object IDs`);
    if (!Number.isInteger(source.defaultBranchCommitCount) || source.defaultBranchCommitCount < 1) {
      fail(`${label}.defaultBranchCommitCount must be positive`);
    }
    assertRepoPath(source.destinationPrefix, `${label}.destinationPrefix`);
    if (prefixes.has(source.destinationPrefix)) fail(`Duplicate destination prefix: ${source.destinationPrefix}`);
    prefixes.add(source.destinationPrefix);
    if (source.tagNamespace !== `${source.name}@`) fail(`${label}.tagNamespace must be ${source.name}@`);

    const sourceTagNames = new Set();
    for (const [included, tags] of [[true, source.releaseTags], [false, source.excludedTags]]) {
      if (!Array.isArray(tags)) fail(`${label} tag lists must be arrays`);
      for (const [tagIndex, tag] of tags.entries()) {
        const tagLabel = `${label}.${included ? 'releaseTags' : 'excludedTags'}[${tagIndex}]`;
        if (typeof tag.name !== 'string' || tag.name.length === 0) fail(`${tagLabel}.name is required`);
        if (sourceTagNames.has(tag.name)) fail(`${label} repeats tag ${tag.name}`);
        sourceTagNames.add(tag.name);
        if (tag.sourceRef !== `refs/tags/${tag.name}`) fail(`${tagLabel}.sourceRef does not match name`);
        if (!isObjectId(tag.objectId) || !isObjectId(tag.targetCommit) || !isObjectId(tag.targetTree)) {
          fail(`${tagLabel} has invalid object IDs`);
        }
        if (!['commit', 'tag'].includes(tag.objectType)) fail(`${tagLabel}.objectType must be commit or tag`);
        if (tag.normalizedTagVersion !== tag.name.replace(/^v/, '')) fail(`${tagLabel}.normalizedTagVersion is wrong`);
        const matches = tag.observedRootPackageVersion === tag.normalizedTagVersion;
        if (included !== matches) fail(`${tagLabel} classification conflicts with the release-tag rule`);
        if (included) {
          const expectedTarget = `${source.tagNamespace}${tag.name}`;
          if (tag.targetName !== expectedTarget) fail(`${tagLabel}.targetName must be ${expectedTarget}`);
          if (targetTags.has(tag.targetName)) fail(`Duplicate target tag: ${tag.targetName}`);
          targetTags.add(tag.targetName);
        }
      }
    }

    if (!Array.isArray(source.moves)) fail(`${label}.moves must be an array`);
    const moveSources = new Set();
    const moveTargets = new Set();
    for (const [moveIndex, move] of source.moves.entries()) {
      const moveLabel = `${label}.moves[${moveIndex}]`;
      assertRepoPath(move.from, `${moveLabel}.from`);
      assertRepoPath(move.to, `${moveLabel}.to`);
      if (!move.from.startsWith(`${source.destinationPrefix}/`)) {
        fail(`${moveLabel}.from must be beneath ${source.destinationPrefix}`);
      }
      if (move.from === move.to) fail(`${moveLabel} is a no-op`);
      if (moveSources.has(move.from) || moveTargets.has(move.to)) fail(`${moveLabel} duplicates a move endpoint`);
      moveSources.add(move.from);
      moveTargets.add(move.to);
    }
  }

  return manifest;
}

export function commitTimestamp(cwd, commit) {
  const value = git(cwd, ['show', '-s', '--format=%ct', commit]).stdout.trim();
  if (!/^\d+$/.test(value)) fail(`Could not read commit timestamp for ${commit}`);
  return Number(value);
}

export function generatedCommitEnv(identity, unixSeconds) {
  const date = `@${unixSeconds} +0000`;
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: date,
  };
}

export function gitVersion() {
  return run('git', ['--version']).stdout.trim();
}

export function filterRepoVersion() {
  const direct = run('git-filter-repo', ['--version'], { allowFailure: true });
  if (direct.status === 0) return { command: 'git-filter-repo', version: direct.stdout.trim() };
  const extension = run('git', ['filter-repo', '--version'], { allowFailure: true });
  if (extension.status === 0) return { command: 'git filter-repo', version: extension.stdout.trim() };
  fail('git-filter-repo is required. Install the pinned version from SPEC.md before running the importer.');
}

export function runFilterRepo(command, args, cwd) {
  if (command === 'git-filter-repo') return run('git-filter-repo', args, { cwd });
  return run('git', ['filter-repo', ...args], { cwd });
}
