import { createHash } from 'node:crypto';
import { constants as fsConstants, accessSync, existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function fail(message) {
  throw new Error(message);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.cleanEnv ? options.env : { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    input: options.input,
    stdio: options.stdio ?? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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

const SAFE_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.excludesFile=/dev/null',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
];

export function sanitizedGitEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_') || ['SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].includes(key)) {
      delete environment[key];
    }
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    TZ: 'UTC',
    ...overrides,
  };
}

export function git(cwd, args, options = {}) {
  return run('git', [...SAFE_GIT_CONFIG, ...args], {
    ...options,
    cwd,
    cleanEnv: true,
    env: sanitizedGitEnvironment(options.env),
  });
}

export function catFileBatch(cwd, objectIds) {
  const objects = new Map();
  const chunkSize = 1000;
  for (let offset = 0; offset < objectIds.length; offset += chunkSize) {
    const chunk = objectIds.slice(offset, offset + chunkSize);
    const result = spawnSync('git', [...SAFE_GIT_CONFIG, 'cat-file', '--batch'], {
      cwd,
      env: sanitizedGitEnvironment(),
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

export function pathWithin(root, candidate) {
  const relation = path.relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation));
}

export async function prospectiveRealpath(filename) {
  const suffix = [];
  let current = path.resolve(filename);
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) fail(`Could not resolve an existing parent for ${filename}`);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(await realpath(current), ...suffix);
}

export async function assertNoSymlinkComponents(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!pathWithin(resolvedRoot, resolvedCandidate)) fail(`${label} escapes its root`);
  const rootMetadata = await lstat(resolvedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) fail(`${label} root must be a real directory`);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!(await pathExists(current))) break;
    if ((await lstat(current)).isSymbolicLink()) fail(`${label} contains a symbolic-link component: ${current}`);
  }
  const [realRoot, realCandidate] = await Promise.all([
    realpath(resolvedRoot),
    prospectiveRealpath(resolvedCandidate),
  ]);
  if (!pathWithin(realRoot, realCandidate)) fail(`${label} resolves outside its root`);
  return realCandidate;
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

export function sha256Buffer(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export async function sha256File(filename) {
  return sha256Buffer(await readFile(filename));
}

export async function sha256Tree(root) {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail(`Digest tree root must be a non-symlink directory: ${root}`);
  }
  const hash = createHash('sha256');
  async function visit(relative = '') {
    const directory = path.join(root, relative);
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => (
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    ));
    for (const entry of entries) {
      const child = path.join(relative, entry.name);
      const filename = path.join(root, child);
      const metadata = await lstat(filename);
      if (metadata.isSymbolicLink()) fail(`Digest tree contains a symbolic link: ${child}`);
      if (metadata.isDirectory()) await visit(child);
      else if (metadata.isFile()) hash.update(child.split(path.sep).join('/')).update('\0').update(await readFile(filename));
      else fail(`Digest tree contains a non-file entry: ${child}`);
    }
  }
  await visit();
  return hash.digest('hex');
}

export function gitBlobBuffer(repository, revision, filename) {
  const objectId = git(repository, ['rev-parse', `${revision}:${filename}`], { allowFailure: true });
  if (objectId.status !== 0 || !isObjectId(objectId.stdout.trim())) {
    fail(`${revision} lacks ${filename}`);
  }
  const object = catFileBatch(repository, [objectId.stdout.trim()]).get(objectId.stdout.trim());
  if (object.objectType !== 'blob') fail(`${revision}:${filename} is not a blob`);
  return object.contents;
}

export function isObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function sourceTagSnapshotSha256(source) {
  const records = [...source.releaseTags, ...source.excludedTags]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tag) => `${tag.name}\0${tag.objectId}\0${tag.targetCommit}\0${tag.classification}`);
  return createHash('sha256').update(records.join('\n')).digest('hex');
}

export function packageVersionAtCommit(repository, commit) {
  const result = git(repository, ['show', `${commit}:package.json`], { allowFailure: true });
  if (result.status !== 0) return null;
  try {
    const packageJson = JSON.parse(result.stdout);
    return typeof packageJson.version === 'string' ? packageJson.version : null;
  } catch {
    return null;
  }
}

export function commitHasSignature(repository, commit) {
  const contents = git(repository, ['cat-file', 'commit', commit]).stdout;
  const headerEnd = contents.indexOf('\n\n');
  if (headerEnd < 0) fail(`Malformed commit object: ${commit}`);
  const headers = `\n${contents.slice(0, headerEnd)}`;
  return headers.includes('\ngpgsig ') || headers.includes('\ngpgsig-sha256 ');
}

export function tagObjectHasSignature(repository, objectId) {
  return git(repository, ['cat-file', '-p', objectId]).stdout.includes('-----BEGIN PGP SIGNATURE-----');
}

export function validateSourceTag(repository, source, tag, included) {
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
  const observedVersion = packageVersionAtCommit(repository, targetCommit);
  if (observedVersion !== tag.observedRootPackageVersion) fail(`Tag package version drifted: ${label}`);
  if ((observedVersion === tag.normalizedTagVersion) !== included) {
    fail(`Tag release classification drifted: ${label}`);
  }
  const reachable = git(repository, ['merge-base', '--is-ancestor', targetCommit, source.defaultHead], {
    allowFailure: true,
  }).status === 0;
  if (reachable !== tag.reachableFromDefault) fail(`Tag reachability drifted: ${label}`);
  if (commitHasSignature(repository, targetCommit) !== tag.targetCommitSigned) {
    fail(`Tag target signature presence drifted: ${label}`);
  }
  if (tag.objectType === 'tag' && tagObjectHasSignature(repository, tag.objectId) !== tag.tagObjectSigned) {
    fail(`Annotated tag signature presence drifted: ${label}`);
  }
}

export function validateLocalSourceMetadata(sourceLocation, sourceName) {
  let repository;
  if (sourceLocation.startsWith('file://')) repository = fileURLToPath(sourceLocation);
  else if (!sourceLocation.includes('://')) repository = sourceLocation;
  else return;
  const gitDirectory = existsSync(path.join(repository, '.git')) ? path.join(repository, '.git') : repository;
  for (const relativePath of ['info/grafts', 'objects/info/alternates']) {
    if (existsSync(path.join(gitDirectory, relativePath))) {
      fail(`${sourceName} source contains unsafe Git metadata before clone: ${relativePath}`);
    }
  }
}

export function validatePinnedSource(repository, source) {
  const replacementRefs = git(repository, ['for-each-ref', '--format=%(refname)', 'refs/replace']).stdout.trim();
  if (replacementRefs) fail(`${source.name} source contains replacement refs: ${replacementRefs.replaceAll('\n', ', ')}`);
  const gitDirectory = git(repository, ['rev-parse', '--absolute-git-dir']).stdout.trim();
  for (const relativePath of ['info/grafts', 'objects/info/alternates']) {
    if (existsSync(path.join(gitDirectory, relativePath))) {
      fail(`${source.name} source contains unsafe Git metadata: ${relativePath}`);
    }
  }
  const head = git(repository, ['rev-parse', source.sourceRef], { allowFailure: true });
  if (head.status !== 0 || head.stdout.trim() !== source.defaultHead) {
    fail(`${source.name} default head drifted: expected ${source.defaultHead}, got ${head.stdout.trim() || '<missing>'}`);
  }
  if (git(repository, ['cat-file', '-t', source.defaultHead]).stdout.trim() !== 'commit') {
    fail(`${source.name} default head is not a commit`);
  }
  if (git(repository, ['rev-parse', `${source.defaultHead}^{tree}`]).stdout.trim() !== source.defaultHeadTree) {
    fail(`${source.name} default head tree drifted`);
  }
  if (Number(git(repository, ['rev-list', '--count', source.defaultHead]).stdout.trim()) !== source.defaultBranchCommitCount) {
    fail(`${source.name} default branch commit count drifted`);
  }
  for (const tag of source.releaseTags) validateSourceTag(repository, source, tag, true);
  for (const tag of source.excludedTags) validateSourceTag(repository, source, tag, false);
  const expectedTags = [...source.releaseTags, ...source.excludedTags].map((tag) => tag.name).sort();
  const actualTags = git(repository, ['tag', '--list']).stdout.split('\n').filter(Boolean).sort();
  if (JSON.stringify(actualTags) !== JSON.stringify(expectedTags)) {
    const expected = new Set(expectedTags);
    const actual = new Set(actualTags);
    const added = actualTags.filter((tag) => !expected.has(tag));
    const missing = expectedTags.filter((tag) => !actual.has(tag));
    fail(`${source.name} tag set drifted; added=[${added.join(',')}], missing=[${missing.join(',')}]`);
  }
}

export function assertRepoPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  if (value.includes('\\')) fail(`${label} must use forward slashes: ${value}`);
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value) {
    fail(`${label} must be a normalized repository-relative path: ${value}`);
  }
  if (value === '.' || value.split('/').includes('..')) fail(`${label} is unsafe: ${value}`);
}

const EXPECTED_SOURCE_URLS = {
  core: 'https://github.com/ui-router/core.git',
  dsr: 'https://github.com/ui-router/dsr.git',
  rx: 'https://github.com/ui-router/rx.git',
  redux: 'https://github.com/ui-router/redux.git',
  'sticky-states': 'https://github.com/ui-router/sticky-states.git',
  visualizer: 'https://github.com/ui-router/visualizer.git',
  angularjs: 'https://github.com/angular-ui/ui-router.git',
  'sample-app-angularjs': 'https://github.com/ui-router/sample-app-angularjs.git',
  angular: 'https://github.com/ui-router/angular.git',
  'sample-app-angular': 'https://github.com/ui-router/sample-app-angular.git',
  'angular-hybrid': 'https://github.com/ui-router/angular-hybrid.git',
  'sample-app-angular-hybrid': 'https://github.com/ui-router/sample-app-angular-hybrid.git',
  react: 'https://github.com/ui-router/react.git',
  'sample-app-react': 'https://github.com/ui-router/sample-app-react.git',
  'react-hybrid': 'https://github.com/ui-router/react-hybrid.git',
  'publish-scripts': 'https://github.com/ui-router/publish-scripts.git',
};

const EXPECTED_SOURCE_ORDER = [
  'core',
  'dsr',
  'rx',
  'redux',
  'sticky-states',
  'visualizer',
  'angularjs',
  'sample-app-angularjs',
  'angular',
  'sample-app-angular',
  'angular-hybrid',
  'sample-app-angular-hybrid',
  'react',
  'sample-app-react',
  'react-hybrid',
  'publish-scripts',
];

export function validateManifest(manifest, { fixture = false } = {}) {
  if (manifest?.schemaVersion !== 1) fail('Manifest schemaVersion must be 1');
  if (!manifest.target || typeof manifest.target.url !== 'string') fail('Manifest target.url is required');
  if (typeof manifest.target.baseBranch !== 'string') fail('Manifest target.baseBranch is required');
  if (manifest.target.baseCommit !== null) fail('Manifest target.baseCommit must remain null; --base supplies the immutable execution input');
  if (typeof manifest.target.outputBranch !== 'string') fail('Manifest target.outputBranch is required');
  const requiredToolchainFields = [
    'node',
    'npm',
    'git',
    'python',
    'uv',
    'gitFilterRepoPackageVersion',
    'gitFilterRepoReportedVersion',
    'gitFilterRepoExecutableSha256',
  ];
  if (!manifest.historyToolchain || requiredToolchainFields.some((field) => (
    typeof manifest.historyToolchain[field] !== 'string' || manifest.historyToolchain[field].length === 0
  ))) {
    fail(`Manifest historyToolchain requires: ${requiredToolchainFields.join(', ')}`);
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.historyToolchain.gitFilterRepoExecutableSha256)) {
    fail('Manifest historyToolchain.gitFilterRepoExecutableSha256 must be a SHA-256 digest');
  }
  if (!manifest.generatedCommitIdentity?.name || !manifest.generatedCommitIdentity?.email) {
    fail('Manifest generatedCommitIdentity name and email are required');
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) fail('Manifest sources must be non-empty');
  if (fixture && manifest.sources.length !== 1) fail('Fixture manifest must contain exactly one source');
  if (fixture && !manifest.target.url.startsWith('file://')) {
    fail('Fixture mode requires a file:// target URL');
  }
  if (!fixture && manifest.target.url !== 'https://github.com/ui-router/ui-router.git') {
    fail('Official manifest target.url must be https://github.com/ui-router/ui-router.git');
  }
  const officialUiRouterTarget = !fixture;
  if (officialUiRouterTarget
    && JSON.stringify(manifest.sources.map((source) => source.name)) !== JSON.stringify(EXPECTED_SOURCE_ORDER)) {
    fail(`Manifest source order must be exactly: ${EXPECTED_SOURCE_ORDER.join(', ')}`);
  }

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
    if (fixture && !source.url.startsWith('file://')) fail(`${label}.url must be local in fixture mode`);
    if (officialUiRouterTarget && source.url !== EXPECTED_SOURCE_URLS[source.name]) {
      fail(`${label}.url must be the canonical public source URL`);
    }
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

    if (!/^[0-9a-f]{64}$/.test(source.tagSnapshotSha256)
      || source.tagSnapshotSha256 !== sourceTagSnapshotSha256(source)) {
      fail(`${label}.tagSnapshotSha256 does not match its locked tag records`);
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
      if (move.to.startsWith(`${move.from}/`) || move.from.startsWith(`${move.to}/`)) {
        fail(`${moveLabel} has ancestor-related endpoints`);
      }
      if (moveSources.has(move.from) || moveTargets.has(move.to)) fail(`${moveLabel} duplicates a move endpoint`);
      moveSources.add(move.from);
      moveTargets.add(move.to);
    }
  }

  return manifest;
}

export function validateManifestImmutable(current, base) {
  const targetFields = ['url', 'baseBranch', 'baseCommit', 'baseCommitPolicy', 'outputBranch'];
  for (const field of targetFields) {
    if (current.target[field] !== base.target[field]) fail(`Manifest target.${field} differs from the target base`);
  }
  if (JSON.stringify(current.generatedCommitIdentity) !== JSON.stringify(base.generatedCommitIdentity)
    || JSON.stringify(current.tagPolicy) !== JSON.stringify(base.tagPolicy)) {
    fail('Manifest identity or tag policy differs from the target base');
  }
  if (current.sources.length !== base.sources.length) fail('Manifest source count differs from the target base');
  const immutableFields = [
    'name', 'url', 'defaultBranch', 'sourceRef', 'destinationPrefix', 'tagNamespace', 'moves',
  ];
  for (const [index, source] of current.sources.entries()) {
    const baseSource = base.sources[index];
    for (const field of immutableFields) {
      if (JSON.stringify(source[field]) !== JSON.stringify(baseSource[field])) {
        fail(`Manifest sources[${index}].${field} differs from the target base`);
      }
    }
  }
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
  return git(process.cwd(), ['--version']).stdout.trim();
}

function findExecutable(command) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  fail(`${command} is required on PATH`);
}

export function filterRepoVersion() {
  const executable = findExecutable('git-filter-repo');
  const direct = run(executable, ['--version'], {
    cleanEnv: true,
    env: sanitizedGitEnvironment(),
  });
  return {
    command: executable,
    version: direct.stdout.trim(),
    executableSha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  };
}

export function executionToolchain(filterRepo = filterRepoVersion()) {
  return {
    node: process.version,
    npm: run('npm', ['--version']).stdout.trim(),
    git: gitVersion(),
    python: run('python3', ['--version']).stdout.trim(),
    uv: run('uv', ['--version']).stdout.trim(),
    gitFilterRepoPackageVersion: '2.47.0',
    gitFilterRepoReportedVersion: filterRepo.version,
    gitFilterRepoExecutableSha256: filterRepo.executableSha256,
  };
}

export function runFilterRepo(command, args, cwd) {
  return run(command, args, {
    cwd,
    cleanEnv: true,
    env: sanitizedGitEnvironment(),
  });
}
