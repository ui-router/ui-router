#!/usr/bin/env node

import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertNoSymlinkComponents, catFileBatch, commitHasSignature, executionToolchain, fail, git, gitBlobBuffer,
  isObjectId, pathExists, readJson,
  run, sha256Buffer, sha256File, sha256Tree, sourceTagSnapshotSha256, tagObjectHasSignature, validateManifest,
  validateManifestImmutable, validatePinnedSource, writeJson,
} from './history-migration-lib.mjs';
import {
  lockedFilterRepoDescriptor, validateExecutionLock, validateExecutionLockInputs, validateExecutionLockPreflight,
} from './control-contract-lib.mjs';

function usage() {
  return `Usage: node tools/lock-history-inputs.mjs --mode <generate|check> [options]

Required:
  --control-root <dir>
  --base <40-hex-commit>
  --decision-date <YYYY-MM-DD>
  --node-lts-line <major>
  --filter-repo-artifact <path-under-control-root>
  --filter-repo-artifact-sha256 <reviewed-digest>
  --filter-repo-wrapper <path-under-control-root>
  --filter-repo-wrapper-sha256 <reviewed-template-digest>
  --filter-repo-package-version <version>
  --schema-validator-artifact <path-under-control-root>
  --schema-validator-sha256 <reviewed-digest>
  --python-executable <absolute-path>
  --python-executable-sha256 <reviewed-digest>
  --os-image <name>
  --os-image-digest <digest>
  --retention-owner <owner>

Generate-only options:
  --write-filter-repo-wrapper   Create the locked local-only Python wrapper
  --fixture                     Enable the one-source local fixture domain

Check-only option:
  --execution-lock-sha256 <reviewed-digest>

Optional:
  --mirror-root <path>          Default: .migration-work/sources
  --bundle-root <path>          Default: .migration-work/bundles
  --architecture <value>        Default: process.arch
  --timezone <value>            Default: UTC
  --locale <value>              Default: C
`;
}

function parseArgs(argv) {
  const options = {
    mirrorRoot: '.migration-work/sources', bundleRoot: '.migration-work/bundles',
    architecture: process.arch, fixture: false, timezone: 'UTC', locale: 'C', writeFilterRepoWrapper: false,
  };
  const flags = new Set(['--write-filter-repo-wrapper', '--fixture']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (flags.has(argument)) {
      if (argument === '--fixture') options.fixture = true;
      else options.writeFilterRepoWrapper = true;
      continue;
    }
    const value = argv[index + 1];
    if (!argument.startsWith('--') || !value || value.startsWith('--')) fail(`Invalid argument: ${argument}`);
    const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = value;
    index += 1;
  }
  const required = [
    'mode', 'controlRoot', 'base', 'decisionDate', 'nodeLtsLine',
    'filterRepoArtifact', 'filterRepoArtifactSha256', 'filterRepoWrapper', 'filterRepoWrapperSha256',
    'filterRepoPackageVersion',
    'schemaValidatorArtifact', 'schemaValidatorSha256', 'pythonExecutable', 'pythonExecutableSha256',
    'osImage', 'osImageDigest', 'retentionOwner',
  ];
  for (const key of required) if (!options[key]) fail(`Missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  if (!['generate', 'check'].includes(options.mode)) fail('--mode must be generate or check');
  if (options.mode === 'check' && options.writeFilterRepoWrapper) {
    fail('--write-filter-repo-wrapper is only valid in generate mode');
  }
  if (options.mode === 'check' && !options.executionLockSha256) {
    fail('--execution-lock-sha256 is required in check mode');
  }
  if (options.executionLockSha256 && !/^[0-9a-f]{64}$/.test(options.executionLockSha256)) {
    fail('--execution-lock-sha256 must be a SHA-256 digest');
  }
  if (!isObjectId(options.base)) fail('--base must be a full lowercase 40-character object ID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.decisionDate)) fail('--decision-date must be YYYY-MM-DD');
  if (!/^[0-9]+$/.test(options.nodeLtsLine)) fail('--node-lts-line must be a major version');
  for (const field of [
    'filterRepoArtifactSha256', 'filterRepoWrapperSha256', 'schemaValidatorSha256', 'pythonExecutableSha256',
  ]) {
    if (!/^[0-9a-f]{64}$/.test(options[field])) fail(`${field} must be a SHA-256 digest`);
  }
  if (!path.isAbsolute(options.pythonExecutable)) fail('--python-executable must be absolute');
  options.controlRoot = path.resolve(options.controlRoot);
  return options;
}

function resolveUnder(root, value, label) {
  const resolved = path.resolve(root, value);
  const relation = path.relative(root, resolved);
  if (relation === '' || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    fail(`${label} must resolve beneath --control-root`);
  }
  return resolved;
}

async function assertRegularUnder(root, filename, label) {
  const metadata = await lstat(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a regular non-symlink file`);
  const [realRoot, realFilename] = await Promise.all([realpath(root), realpath(filename)]);
  const relation = path.relative(realRoot, realFilename);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    fail(`${label} resolves outside --control-root`);
  }
}

function relativeToControl(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
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

async function filterRepoDescriptor(options) {
  const wrapper = resolveUnder(options.controlRoot, options.filterRepoWrapper, 'filter-repo wrapper');
  const artifact = resolveUnder(options.controlRoot, options.filterRepoArtifact, 'filter-repo artifact');
  if (await sha256File(wrapper) !== options.filterRepoWrapperSha256
    || await sha256File(artifact) !== options.filterRepoArtifactSha256) {
    fail('Filter-repo wrapper or artifact changed before the version probe');
  }
  const result = run(options.pythonExecutable, [artifact, '--version'], {
    cleanEnv: true,
    env: { ...lockedPythonEnvironment(options.pythonExecutable), UIROUTER_DIRECT_ARTIFACT_PROBE: '1' },
  });
  return {
    command: wrapper,
    version: result.stdout.trim(),
    executableSha256: null,
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function expectedWrapperContents(wrapper, artifact, pythonExecutable) {
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

async function maybeWriteWrapper(options) {
  const wrapper = resolveUnder(options.controlRoot, options.filterRepoWrapper, 'filter-repo wrapper');
  const artifact = resolveUnder(options.controlRoot, options.filterRepoArtifact, 'filter-repo artifact');
  if (!(await pathExists(artifact))) fail(`Filter-repo artifact is missing: ${artifact}`);
  const expected = expectedWrapperContents(wrapper, artifact, options.pythonExecutable);
  if (sha256Buffer(Buffer.from(expected)) !== options.filterRepoWrapperSha256) {
    fail('Reviewed wrapper digest differs from the deterministic wrapper template');
  }
  if (!(await pathExists(wrapper))) {
    if (!options.writeFilterRepoWrapper) fail(`Filter-repo wrapper is missing: ${wrapper}`);
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, expected);
    await chmod(wrapper, 0o755);
  }
  if (await readFile(wrapper, 'utf8') !== expected) {
    fail('Filter-repo wrapper differs from the locked local-artifact-only template');
  }
}

function signedCommitCount(repository, head) {
  const commits = git(repository, ['rev-list', head]).stdout.split('\n').filter(Boolean);
  const objects = catFileBatch(repository, commits);
  let count = 0;
  for (const commit of commits) {
    const contents = objects.get(commit).contents;
    const separator = contents.indexOf(Buffer.from('\n\n'));
    const headers = `\n${contents.subarray(0, separator).toString('utf8')}\n`;
    if (headers.includes('\ngpgsig ') || headers.includes('\ngpgsig-sha256 ')) count += 1;
  }
  return count;
}

function tagRecord(repository, source, name) {
  const sourceRef = `refs/tags/${name}`;
  const objectId = git(repository, ['rev-parse', sourceRef]).stdout.trim();
  const objectType = git(repository, ['cat-file', '-t', objectId]).stdout.trim();
  const targetCommit = git(repository, ['rev-parse', `${sourceRef}^{commit}`]).stdout.trim();
  const targetTree = git(repository, ['rev-parse', `${targetCommit}^{tree}`]).stdout.trim();
  const normalizedTagVersion = name.replace(/^v/, '');
  const packageResult = git(repository, ['show', `${targetCommit}:package.json`], { allowFailure: true });
  let observedRootPackageVersion = null;
  if (packageResult.status === 0) {
    try {
      observedRootPackageVersion = JSON.parse(packageResult.stdout).version ?? null;
    } catch {
      observedRootPackageVersion = null;
    }
  }
  const included = observedRootPackageVersion === normalizedTagVersion;
  const record = {
    name, sourceRef, normalizedTagVersion, objectId, objectType, targetCommit, targetTree,
    targetCommitSigned: commitHasSignature(repository, targetCommit),
    reachableFromDefault: git(repository, ['merge-base', '--is-ancestor', targetCommit, source.sourceRef], {
      allowFailure: true,
    }).status === 0,
    observedRootPackageVersion,
    classification: included ? 'root-package-version-match' : 'root-package-version-mismatch',
  };
  if (included) record.targetName = `${source.tagNamespace}${name}`;
  if (objectType === 'tag') record.tagObjectSigned = tagObjectHasSignature(repository, objectId);
  return { included, record };
}

function refreshSource(repository, prior) {
  const remoteDefaultRef = git(repository, ['symbolic-ref', 'HEAD'], { allowFailure: true }).stdout.trim();
  if (remoteDefaultRef !== prior.sourceRef) {
    fail(`${prior.name} remote default branch changed: expected ${prior.sourceRef}, got ${remoteDefaultRef || '<detached>'}`);
  }
  const defaultHead = git(repository, ['rev-parse', prior.sourceRef]).stdout.trim();
  const source = {
    ...prior,
    defaultHead,
    defaultHeadTree: git(repository, ['rev-parse', `${defaultHead}^{tree}`]).stdout.trim(),
    defaultBranchCommitCount: Number(git(repository, ['rev-list', '--count', defaultHead]).stdout.trim()),
    releaseTags: [], excludedTags: [],
    signedDefaultBranchCommitCount: signedCommitCount(repository, defaultHead),
  };
  const tagNames = git(repository, ['tag', '--list']).stdout.split('\n').filter(Boolean).sort();
  for (const name of tagNames) {
    const { included, record } = tagRecord(repository, source, name);
    (included ? source.releaseTags : source.excludedTags).push(record);
  }
  source.tagSnapshotSha256 = sourceTagSnapshotSha256(source);
  return source;
}

function assertRemoteSnapshot(controlRoot, source) {
  const actual = git(controlRoot, ['ls-remote', '--heads', '--tags', source.url]).stdout
    .split('\n').filter(Boolean).map((line) => {
      const [objectId, ref] = line.split(/\s+/);
      return `${ref} ${objectId}`;
    }).filter((line) => line.startsWith(`${source.sourceRef} `) || line.startsWith('refs/tags/')).sort();
  const expected = [`${source.sourceRef} ${source.defaultHead}`];
  for (const tag of [...source.releaseTags, ...source.excludedTags]) {
    expected.push(`${tag.sourceRef} ${tag.objectId}`);
    if (tag.objectType === 'tag') expected.push(`${tag.sourceRef}^{} ${tag.targetCommit}`);
  }
  expected.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${source.name} remote refs changed during H01 generation`);
}

function pruneMirror(repository, includedRefs) {
  const allowed = new Set(includedRefs);
  const refs = git(repository, ['for-each-ref', '--format=%(refname)']).stdout.split('\n').filter(Boolean);
  for (const ref of refs) if (!allowed.has(ref)) git(repository, ['update-ref', '-d', ref]);
  const remaining = git(repository, ['for-each-ref', '--format=%(refname)']).stdout.split('\n').filter(Boolean).sort();
  if (JSON.stringify(remaining) !== JSON.stringify([...allowed].sort())) fail('Retained mirror ref pruning failed');
}
async function generate(options) {
  const manifestPath = path.join(options.controlRoot, 'migration/sources.json');
  const lockPath = path.join(options.controlRoot, 'migration/execution-lock.json');
  const mirrorRoot = resolveUnder(options.controlRoot, options.mirrorRoot, 'mirror root');
  const bundleRoot = resolveUnder(options.controlRoot, options.bundleRoot, 'bundle root');
  const executionEvidenceRoot = path.join(options.controlRoot, 'migration/control-evidence/execution-lock');
  for (const filename of [lockPath, mirrorRoot, bundleRoot, executionEvidenceRoot]) {
    if (await pathExists(filename)) fail(`Refusing to overwrite existing H01 input: ${filename}`);
  }
  if (!(await pathExists(manifestPath))) fail(`Source manifest is missing: ${manifestPath}`);
  const artifact = resolveUnder(options.controlRoot, options.filterRepoArtifact, 'filter-repo artifact');
  const wrapper = resolveUnder(options.controlRoot, options.filterRepoWrapper, 'filter-repo wrapper');
  const validator = resolveUnder(options.controlRoot, options.schemaValidatorArtifact, 'schema validator artifact');
  for (const [label, filename] of [
    ['mirror root', mirrorRoot], ['bundle root', bundleRoot], ['execution evidence root', executionEvidenceRoot],
    ['filter-repo artifact', artifact], ['filter-repo wrapper', wrapper], ['schema validator', validator],
  ]) await assertNoSymlinkComponents(options.controlRoot, filename, label);
  await maybeWriteWrapper(options);
  for (const [label, filename] of [['filter-repo artifact', artifact], ['filter-repo wrapper', wrapper], ['schema validator', validator]]) {
    if (!(await pathExists(filename))) fail(`${label} is missing: ${filename}`);
    await assertRegularUnder(options.controlRoot, filename, label);
  }
  const pythonMetadata = await lstat(options.pythonExecutable);
  if (pythonMetadata.isSymbolicLink() || !pythonMetadata.isFile()) {
    fail('--python-executable must be a regular non-symlink file');
  }
  if (await sha256File(artifact) !== options.filterRepoArtifactSha256) {
    fail('Filter-repo artifact differs from the pre-reviewed digest');
  }
  if (await sha256File(validator) !== options.schemaValidatorSha256) {
    fail('Schema validator differs from the pre-reviewed digest');
  }
  if (await sha256File(options.pythonExecutable) !== options.pythonExecutableSha256) {
    fail('Python executable differs from the pre-reviewed digest');
  }

  const priorManifest = validateManifest(await readJson(manifestPath), { fixture: options.fixture });
  if (!options.fixture) {
    if (git(options.controlRoot, ['rev-parse', 'HEAD']).stdout.trim() !== options.base) {
      fail('H01 generation must start with control HEAD exactly at --base');
    }
    if (git(options.controlRoot, ['status', '--porcelain', '--untracked-files=no']).stdout !== '') {
      fail('Control checkout has tracked modifications before H01 generation');
    }
    if (git(options.controlRoot, ['rev-list', '--merges', `${options.base}..HEAD`]).stdout.trim() !== '') {
      fail('Control branch must remain linear after the locked target base');
    }
  }
  const remoteBase = git(options.controlRoot, [
    'ls-remote', priorManifest.target.url, `refs/heads/${priorManifest.target.baseBranch}`,
  ]).stdout.trim().split(/\s+/)[0];
  if (remoteBase !== options.base) fail(`Target remote ${priorManifest.target.baseBranch} differs from --base`);
  const baseRepository = options.fixture ? fileURLToPath(priorManifest.target.url) : options.controlRoot;
  const baseManifest = gitBlobBuffer(baseRepository, options.base, 'migration/sources.json');
  const targetBaseSourceManifestSha256 = sha256Buffer(baseManifest);
  const baseManifestJson = validateManifest(JSON.parse(baseManifest.toString('utf8')), { fixture: options.fixture });
  if (!options.fixture) validateManifestImmutable(priorManifest, baseManifestJson);

  const descriptor = await filterRepoDescriptor(options);
  descriptor.executableSha256 = options.filterRepoWrapperSha256;
  const flatToolchain = executionToolchain(descriptor);
  const lockedPythonVersion = run(options.pythonExecutable, ['--version'], {
    cleanEnv: true,
    env: lockedPythonEnvironment(options.pythonExecutable),
  }).stdout.trim();
  if (lockedPythonVersion !== flatToolchain.python) {
    fail(`Locked Python version ${lockedPythonVersion} differs from PATH Python ${flatToolchain.python}`);
  }
  const observedNodeLine = flatToolchain.node.replace(/^v/, '').split('.')[0];
  if (observedNodeLine !== options.nodeLtsLine) {
    fail(`Observed Node major ${observedNodeLine} differs from --node-lts-line ${options.nodeLtsLine}`);
  }
  const toolchain = {
    node: flatToolchain.node,
    nodeLtsLine: options.nodeLtsLine,
    npm: flatToolchain.npm,
    git: flatToolchain.git,
    python: flatToolchain.python,
    pythonExecutable: options.pythonExecutable,
    pythonExecutableSha256: options.pythonExecutableSha256,
    uv: flatToolchain.uv,
    contractSchemaBundleSha256: await sha256Tree(path.join(options.controlRoot, 'migration/schemas')),
    gitFilterRepo: {
      packageVersion: options.filterRepoPackageVersion,
      reportedVersion: descriptor.version,
      artifactPath: relativeToControl(options.controlRoot, artifact),
      artifactSha256: options.filterRepoArtifactSha256,
      wrapperPath: relativeToControl(options.controlRoot, wrapper),
      wrapperSha256: options.filterRepoWrapperSha256,
    },
    contractSchemaValidator: {
      name: 'ui-router-contract-validator', version: '1',
      artifactPath: relativeToControl(options.controlRoot, validator),
      artifactSha256: options.schemaValidatorSha256,
    },
    runtime: {
      osImage: options.osImage, osImageDigest: options.osImageDigest,
      architecture: options.architecture, timezone: options.timezone, locale: options.locale, browser: null,
    },
  };
  if (toolchain.gitFilterRepo.packageVersion !== flatToolchain.gitFilterRepoPackageVersion) {
    fail(`Filter-repo package version must be ${flatToolchain.gitFilterRepoPackageVersion}`);
  }

  await mkdir(mirrorRoot, { recursive: false });
  await mkdir(bundleRoot, { recursive: false });
  await mkdir(executionEvidenceRoot, { recursive: true });
  const refreshedSources = [];
  const sourceLocks = [];
  for (const prior of priorManifest.sources) {
    console.log(`[${prior.name}] fresh-cloning remote source`);
    const mirror = path.join(mirrorRoot, `${prior.name}.git`);
    git(options.controlRoot, ['clone', '--mirror', prior.url, mirror]);
    const source = refreshSource(mirror, prior);
    const includedRefs = [
      source.sourceRef, ...source.releaseTags.map((tag) => tag.sourceRef),
      ...source.excludedTags.map((tag) => tag.sourceRef),
    ].sort();
    pruneMirror(mirror, includedRefs);
    validatePinnedSource(mirror, source);
    const bundle = path.join(bundleRoot, `${prior.name}.bundle`);
    git(mirror, ['bundle', 'create', bundle, ...includedRefs]);
    git(mirror, ['bundle', 'verify', bundle]);
    const bundleSha256 = await sha256File(bundle);
    const restore = path.join(bundleRoot, `.restore-${prior.name}.git`);
    git(options.controlRoot, ['clone', '--mirror', bundle, restore]);
    validatePinnedSource(restore, source);
    const restoredRefs = git(restore, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout
      .split('\n').filter(Boolean).sort();
    const mirrorRefs = git(mirror, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout
      .split('\n').filter(Boolean).sort();
    if (JSON.stringify(restoredRefs) !== JSON.stringify(mirrorRefs)) fail(`${prior.name} restored bundle refs differ`);
    await rm(restore, { recursive: true, force: true });
    const evidenceRelative = `migration/control-evidence/execution-lock/${prior.name}.json`;
    const evidencePath = path.join(options.controlRoot, evidenceRelative);
    await writeJson(evidencePath, {
      schemaVersion: 1, name: prior.name, defaultHead: source.defaultHead,
      refs: mirrorRefs, bundleSha256,
    });
    refreshedSources.push(source);
    sourceLocks.push({
      name: prior.name, defaultHead: source.defaultHead, tagSnapshotSha256: source.tagSnapshotSha256,
      mirrorPath: relativeToControl(options.controlRoot, mirror),
      bundlePath: relativeToControl(options.controlRoot, bundle), bundleSha256,
      objectFormat: git(mirror, ['rev-parse', '--show-object-format']).stdout.trim(),
      includedRefs, retentionOwner: options.retentionOwner,
      evidence: { path: evidenceRelative, sha256: await sha256File(evidencePath) },
    });
  }

  for (const source of refreshedSources) assertRemoteSnapshot(options.controlRoot, source);
  const finalTargetBase = git(options.controlRoot, [
    'ls-remote', priorManifest.target.url, `refs/heads/${priorManifest.target.baseBranch}`,
  ]).stdout.trim().split(/\s+/)[0];
  if (finalTargetBase !== options.base) fail(`Target remote ${priorManifest.target.baseBranch} changed during H01 generation`);

  const manifest = {
    ...priorManifest,
    sourceSnapshotDate: options.decisionDate,
    historyToolchain: flatToolchain,
    sources: refreshedSources,
  };
  await writeJson(manifestPath, manifest);
  validateManifest(await readJson(manifestPath), { fixture: options.fixture });
  const executionLock = {
    schemaVersion: 1, decisionDate: options.decisionDate, targetBase: options.base,
    targetBaseSourceManifestSha256,
    sourceManifestSha256: await sha256File(manifestPath),
    toolchain,
    sources: sourceLocks,
  };
  await writeJson(lockPath, executionLock);
  await validateExecutionLock({
    contractRoot: options.controlRoot, artifactRoot: options.controlRoot,
    manifest, executionLock, filterRepo: descriptor, expectedBase: options.base, fixture: options.fixture,
  });
  console.log(`HISTORY_INPUTS_LOCKED sources=${sourceLocks.length}`);
  console.log(`manifest=${await sha256File(manifestPath)}`);
  console.log(`executionLock=${await sha256File(lockPath)}`);
}

async function check(options) {
  const manifestPath = path.join(options.controlRoot, 'migration/sources.json');
  const lockPath = path.join(options.controlRoot, 'migration/execution-lock.json');
  if (await sha256File(lockPath) !== options.executionLockSha256) {
    fail('Execution lock differs from the separately reviewed digest');
  }
  await maybeWriteWrapper(options);
  const manifest = validateManifest(await readJson(manifestPath), { fixture: options.fixture });
  const executionLock = await readJson(lockPath);
  if (executionLock.decisionDate !== options.decisionDate) fail('Execution-lock decision date differs');
  {
    if (!options.fixture) {
      if (git(options.controlRoot, ['merge-base', '--is-ancestor', options.base, 'HEAD'], { allowFailure: true }).status !== 0) {
        fail('--base is not an ancestor of the control branch HEAD');
      }
      if (git(options.controlRoot, ['status', '--porcelain', '--untracked-files=no']).stdout !== '') {
        fail('Control checkout has tracked modifications');
      }
      if (git(options.controlRoot, ['rev-list', '--merges', `${options.base}..HEAD`]).stdout.trim() !== '') {
        fail('Control branch must remain linear after the locked target base');
      }
    }
    const remoteBase = git(options.controlRoot, [
      'ls-remote', manifest.target.url, `refs/heads/${manifest.target.baseBranch}`,
    ]).stdout.trim().split(/\s+/)[0];
    if (remoteBase !== options.base) fail(`Target remote ${manifest.target.baseBranch} differs from --base`);
    const baseRepository = options.fixture ? fileURLToPath(manifest.target.url) : options.controlRoot;
    const baseManifest = gitBlobBuffer(baseRepository, options.base, 'migration/sources.json');
    if (sha256Buffer(baseManifest) !== executionLock.targetBaseSourceManifestSha256) {
      fail('Target-base source-manifest digest differs');
    }
    const baseManifestJson = validateManifest(JSON.parse(baseManifest.toString('utf8')), { fixture: options.fixture });
    if (!options.fixture) validateManifestImmutable(manifest, baseManifestJson);
  }
  const expectedOptions = {
    artifactPath: relativeToControl(options.controlRoot, resolveUnder(options.controlRoot, options.filterRepoArtifact, 'filter-repo artifact')),
    wrapperPath: relativeToControl(options.controlRoot, resolveUnder(options.controlRoot, options.filterRepoWrapper, 'filter-repo wrapper')),
    validatorPath: relativeToControl(options.controlRoot, resolveUnder(options.controlRoot, options.schemaValidatorArtifact, 'schema validator')),
  };
  if (executionLock.toolchain.gitFilterRepo.artifactPath !== expectedOptions.artifactPath
    || executionLock.toolchain.gitFilterRepo.artifactSha256 !== options.filterRepoArtifactSha256
    || executionLock.toolchain.gitFilterRepo.wrapperPath !== expectedOptions.wrapperPath
    || executionLock.toolchain.gitFilterRepo.wrapperSha256 !== options.filterRepoWrapperSha256
    || executionLock.toolchain.nodeLtsLine !== options.nodeLtsLine
    || executionLock.toolchain.gitFilterRepo.packageVersion !== options.filterRepoPackageVersion
    || executionLock.toolchain.contractSchemaValidator.artifactPath !== expectedOptions.validatorPath
    || executionLock.toolchain.contractSchemaValidator.artifactSha256 !== options.schemaValidatorSha256
    || executionLock.toolchain.pythonExecutable !== options.pythonExecutable
    || executionLock.toolchain.pythonExecutableSha256 !== options.pythonExecutableSha256
    || executionLock.toolchain.runtime.osImage !== options.osImage
    || executionLock.toolchain.runtime.osImageDigest !== options.osImageDigest
    || executionLock.toolchain.runtime.architecture !== options.architecture
    || executionLock.toolchain.runtime.timezone !== options.timezone
    || executionLock.toolchain.runtime.locale !== options.locale
    || executionLock.sources.some((source) => source.retentionOwner !== options.retentionOwner)) {
    fail('Execution-lock generation options differ');
  }
  await validateExecutionLockPreflight({
    contractRoot: options.controlRoot,
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    expectedBase: options.base,
    fixture: options.fixture,
  });
  await validateExecutionLockInputs({
    artifactRoot: options.controlRoot,
    manifest,
    executionLock,
    fixture: options.fixture,
    requireCommittedControl: !options.fixture,
  });
  for (const source of manifest.sources) assertRemoteSnapshot(options.controlRoot, source);
  const descriptor = await lockedFilterRepoDescriptor(options.controlRoot, executionLock);
  await validateExecutionLock({
    contractRoot: options.controlRoot, artifactRoot: options.controlRoot,
    manifest, executionLock, filterRepo: descriptor, expectedBase: options.base, fixture: options.fixture,
  });
  console.log(`HISTORY_INPUTS_OK sources=${executionLock.sources.length}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!(await pathExists(options.controlRoot))) fail(`Control root is missing: ${options.controlRoot}`);
  if (options.mode === 'generate') await generate(options);
  else await check(options);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
