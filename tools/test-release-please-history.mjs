import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ExcludeHousekeeping } from '../.github/release-please/excluded-commits.mjs';
import exclusions from '../.github/release-please/excluded-commits.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const { Manifest, VERSION, setLogger } = require('release-please');
const { FileNotFoundError } = require('release-please/build/src/errors/index.js');
const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const config = JSON.parse(read('release-please-config.json'));
const react = 'frameworks/react/uirouter-react';
const angular = 'frameworks/angular/uirouter-angular';
// Synthetic release history needs fixed baselines even when a real release PR
// changes the repository's package and manifest versions.
const versions = Object.fromEntries(Object.keys(config.packages).map(path => [path, '1.0.0']));
versions[react] = '1.0.8';
versions[angular] = '22.0.0';
const logger = Object.fromEntries(['error', 'warn', 'info', 'debug', 'trace'].map(level => [level, () => {}]));
setLogger(logger);
const commit = (sha, message, files = []) => ({ sha, message, files });

async function proposals(commits, releaseConfig = config, tags) {
  const github = {
    repository: { owner: 'ui-router', repo: 'ui-router', defaultBranch: 'main' },
    getFileJson: async file => {
      if (file === 'release-please-config.json') return releaseConfig;
      if (file === '.release-please-manifest.json') return versions;
      return JSON.parse(read(file));
    },
    getFileContentsOnBranch: async file => {
      let text;
      try { text = read(file); } catch { throw new FileNotFoundError(file); }
      return { parsedContent: text, content: Buffer.from(text).toString('base64'), sha: 'fixture' };
    },
    async *releaseIterator() {},
    async *tagIterator() {
      for (const [path, version] of Object.entries(versions)) {
        yield { name: `${config.packages[path].component}@${version}`, sha: tags?.[path] ?? 'baseline' };
      }
    },
    async *mergeCommitIterator() { yield* commits; },
  };
  const manifest = await Manifest.fromManifest(github, 'main', undefined, undefined, { logger });
  manifest.plugins.unshift(new ExcludeHousekeeping(github, 'main', manifest.repositoryConfig));
  assert.equal(manifest.lastReleaseSha, undefined);
  assert.equal(manifest.bootstrapSha, undefined);
  return (await manifest.buildPullRequests()).map(candidate => ({
    ...candidate,
    path: candidate.updates.find(update => update.path.endsWith('/CHANGELOG.md')).path.replace('/CHANGELOG.md', ''),
  }));
}

test('history policy runs against the pinned Release Please library', () => {
  assert.equal(VERSION, '17.3.0');
});

test('housekeeping exclusions use full commit IDs with a review reason', () => {
  for (const [sha, reason] of Object.entries(exclusions)) {
    assert.match(sha, /^[a-f0-9]{40}$/);
    assert.ok(reason.trim());
  }
});

test('excluded changes cannot trigger a bump or enter the notes of a genuine release', async () => {
  const docs = commit('69b5554ac6522820c74119e01321bf8f8e968c9e', 'feat!: docs migration', [react + '/package.json', angular + '/package.json']);
  const baseline = commit('baseline', 'chore: previous release');
  assert.deepEqual(await proposals([docs, baseline]), []);
  const candidates = await proposals([commit('new-fix', 'fix: router update', [react + '/src/router.ts']), docs, baseline]);
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.path, react);
  assert.equal(candidate.version.toString(), '1.0.9');
  assert.match(candidate.body.toString(), /router update/);
  assert.doesNotMatch(candidate.body.toString(), /docs migration/);
});

test('new publish-scripts features cannot trigger proposals', async () => {
  const candidates = await proposals([
    commit('new-cli-feature', 'feat: add local release tooling', ['tools/publish-scripts/release.js']),
    commit('baseline', 'chore: previous release'),
  ]);
  assert.deepEqual(candidates, []);
});

test('empty imported commits cannot bump versions or leak into another package changelog', async () => {
  const history = [
    commit('react-fix', 'fix: keep React routing working', [`${react}/src/router.ts`]),
    commit('angular-feature', 'feat: add Angular routing', [`${angular}/src/router.ts`]),
    // This message and empty file list reproduce the imported Angular commit.
    commit('8a2d6500d335b8400ca48f786aaf33938ac274ce', 'feat: Support Angular 9-10\n\nBREAKING CHANGE:\n- Drop support for Angular v8\n- Add support for Angular v10'),
    commit('empty-release-as', 'chore: set versions\n\nRelease-As: 99.0.0'),
    commit('baseline', 'chore: previously published versions'),
  ];
  const candidates = await proposals(history);
  assert.deepEqual(candidates.map(c => [c.path, c.version.toString()]), [
    [angular, '22.1.0'],
    [react, '1.0.9'],
  ]);
  for (const candidate of candidates) {
    assert.equal(candidate.draft, true);
    assert.doesNotMatch(candidate.body.toString(), /Support Angular 9-10|BREAKING CHANGES|99\.0\.0/);
  }
  assert.doesNotMatch(candidates.find(c => c.path === react).body.toString(), /add Angular routing/);

  // Positive control: the unfiltered configuration actually reproduces the bug.
  const unfiltered = structuredClone(config);
  delete unfiltered['exclude-paths'];
  const broken = await proposals(history.filter(c => c.sha !== 'empty-release-as'), unfiltered);
  assert.equal(broken.find(c => c.path === react).version.toString(), '2.0.0');
  assert.match(broken.find(c => c.path === react).body.toString(), /Support Angular 9-10/);
});

test('real breaking changes and changes spanning packages still reach their packages', async () => {
  const candidates = await proposals([
    commit('react-breaking', 'feat!: remove obsolete React API', [`${react}/src/router.ts`]),
    commit('shared-fix', 'fix: support both frameworks', [`${react}/package.json`, `${angular}/package.json`]),
    commit('baseline', 'chore: previously published versions'),
  ]);
  assert.deepEqual(candidates.map(c => [c.path, c.version.toString()]), [
    [angular, '22.0.1'],
    [react, '2.0.0'],
  ]);
  for (const candidate of candidates) assert.match(candidate.body.toString(), /support both frameworks/);
  assert.match(candidates.find(c => c.path === react).body.toString(), /remove obsolete React API/);
});

test('empty release-tag commits still delimit each package history before filtering', async () => {
  const candidates = await proposals([
    commit('react-fix', 'fix: new React change', [`${react}/src/router.ts`]),
    commit('react-baseline', 'chore: published React'),
    commit('old-react-feature', 'feat!: already published React change', [`${react}/src/router.ts`]),
    commit('angular-fix', 'fix: new Angular change', [`${angular}/src/router.ts`]),
    commit('angular-baseline', 'chore: published Angular'),
    commit('old-angular-feature', 'feat!: already published Angular change', [`${angular}/src/router.ts`]),
    commit('baseline', 'chore: other published versions'),
  ], config, { [react]: 'react-baseline', [angular]: 'angular-baseline' });
  assert.deepEqual(candidates.map(c => [c.path, c.version.toString()]), [
    [angular, '22.0.1'],
    [react, '1.0.9'],
  ]);
  for (const candidate of candidates) assert.doesNotMatch(candidate.body.toString(), /already published/);
});
