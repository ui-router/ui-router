import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = file => JSON.parse(readFileSync(new URL(file, root), 'utf8'));

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
    assert.deepEqual(config.packages[dir]['extra-files'], [
      { type: 'json', path: '/package-lock.json', jsonpath: `$.packages['${dir}'].version` },
    ]);
  }
  assert.equal(config['separate-pull-requests'], true);
  assert.equal(config['include-v-in-tag'], false);
  assert.equal(config['release-type'], 'node');
});
