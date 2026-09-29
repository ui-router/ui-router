import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { refreshReleaseLock } from './refresh-release-locks.mjs';

const root = new URL('../', import.meta.url);
const read = file => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
const branch = 'release-please--branches--main--components--react';
const sha = 'a'.repeat(40);
const pr = { number: 1, head: { ref: branch, sha, repo: { full_name: 'ui-router/ui-router' } },
  base: { ref: 'main', repo: { full_name: 'ui-router/ui-router' } }, labels: [{ name: 'autorelease: pending' }] };
function setup({ diff = 'package-lock.json', fetched = sha, fail } = {}) {
  const calls = [];
  const options = { root: '/unused', repository: 'ui-router/ui-router', branches: [branch], run(command, args) {
    calls.push([command, ...args]);
    if (fail?.(command, args)) throw new Error('simulated failure');
    if (args[0] === 'rev-parse') return fetched;
    if (args[0] === 'diff') return diff;
    return '';
  } };
  return { calls, options };
}
const pushed = calls => calls.some(call => call.includes('push'));

test('release configuration covers only the public package inventory', () => {
  const config = read('release-please-config.json');
  const manifest = read('.release-please-manifest.json');
  const inventory = read('tools/packages.json').packages;
  const paths = inventory.map(pkg => pkg.manifest.replace(/\/package.json$/, '')).sort();
  assert.deepEqual(Object.keys(config.packages).sort(), paths);
  assert.deepEqual(Object.keys(manifest).sort(), paths);
  for (const pkg of inventory) {
    const dir = pkg.manifest.replace(/\/package.json$/, '');
    assert.equal(config.packages[dir].component + config['tag-separator'], pkg.tagNamespace);
    assert.match(manifest[dir], /^\d+\.\d+\.\d+$/);
  }
  assert.equal(config['separate-pull-requests'], true);
  assert.equal(config['include-v-in-tag'], false);
  assert.equal(config['release-type'], 'node');
});

test('refreshes only the root lock with scripts disabled and a normal push', () => {
  const { calls, options } = setup();
  assert.equal(refreshReleaseLock(pr, options), true);
  assert(calls.some(call => call[0] === 'npm' && call.includes('--ignore-scripts') && call.includes('--package-lock-only')));
  assert.deepEqual(calls.find(call => call[1] === 'add'), ['git', 'add', '--', 'package-lock.json']);
  const push = calls.find(call => call.includes('push'));
  assert(push.includes(`HEAD:refs/heads/${branch}`));
  assert(!push.some(arg => arg.includes('--force')));
  assert(calls.some(call => call[1] === 'worktree' && call[2] === 'remove'));
});

test('does not commit or push an unchanged lock', () => {
  const { calls, options } = setup({ diff: '' });
  assert.equal(refreshReleaseLock(pr, options), false);
  assert(!pushed(calls));
  assert(!calls.some(call => call.includes('commit')));
});

test('rejects foreign PRs and branches before running commands', () => {
  for (const changed of [
    { ...pr, head: { ...pr.head, repo: { full_name: 'someone/fork' } } },
    { ...pr, head: { ...pr.head, ref: 'main' } },
    { ...pr, base: { ...pr.base, ref: 'other' } },
    { ...pr, labels: [] },
  ]) {
    const { calls, options } = setup();
    assert.throws(() => refreshReleaseLock(changed, options), /unexpected release PR/);
    assert.equal(calls.length, 0);
  }
});

test('stops if the branch moves or npm changes another file', () => {
  for (const scenario of [{ fetched: 'b'.repeat(40) }, { diff: 'package-lock.json\npackage.json' }]) {
    const { calls, options } = setup(scenario);
    assert.throws(() => refreshReleaseLock(pr, options));
    assert(!pushed(calls));
  }
});

test('propagates npm and push failures and removes its temporary checkout', () => {
  for (const fail of [(command) => command === 'npm', (_, args) => args.includes('push')]) {
    const { calls, options } = setup({ fail });
    assert.throws(() => refreshReleaseLock(pr, options), /simulated failure/);
    assert(calls.some(call => call[1] === 'worktree' && call[2] === 'remove'));
  }
});
