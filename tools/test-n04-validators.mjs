#!/usr/bin/env node
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'uirouter-n04-negative-'));
const json = (root, file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const save = (root, file, value) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
let passed = 0;

function checkout(name) {
  const root = path.join(tempRoot, name);
  mkdirSync(root);
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: source, maxBuffer: 128 * 1024 * 1024 });
  const tar = spawnSync('tar', ['-x', '-C', root], { input: archive, encoding: null });
  if (tar.status !== 0) throw new Error(`tar extraction failed: ${tar.stderr}`);
  for (const file of ['verify-layout.mjs', 'verify-internal-deps.mjs']) cpSync(path.join(source, 'tools', file), path.join(root, 'tools', file));
  cpSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
  return root;
}

function expectFailure(name, validator, mutate, expected) {
  const root = checkout(name);
  mutate(root);
  const result = spawnSync(process.execPath, [`tools/${validator}`], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0) throw new Error(`${name}: validator unexpectedly passed`);
  if (!expected.test(output)) throw new Error(`${name}: expected ${expected}, got:\n${output}`);
  passed += 1;
}

function expectSuccess(name, validator, mutate, expected) {
  const root = checkout(name);
  mutate(root);
  const result = spawnSync(process.execPath, [`tools/${validator}`], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0 || !expected.test(output)) throw new Error(`${name}: expected success ${expected}, got:\n${output}`);
  passed += 1;
}

try {
  expectFailure('layout-extra-manifest', 'verify-layout.mjs', (root) => {
    const dir = path.join(root, 'frameworks/angular/examples/rogue'); mkdirSync(dir, { recursive: true });
    save(root, 'frameworks/angular/examples/rogue/package.json', { name: '@uirouter/internal-rogue', private: true });
  }, /expected 45 current manifests/);
  expectFailure('layout-duplicate-name', 'verify-layout.mjs', (root) => {
    const file = 'frameworks/react/examples/typescript/package.json'; const value = json(root, file);
    value.name = '@uirouter/core'; save(root, file, value);
  }, /name .* != classified|duplicate package name/);
  expectFailure('layout-public-example', 'verify-layout.mjs', (root) => {
    const file = 'plugins/dsr/examples/angular-cli/package.json'; const value = json(root, file);
    value.private = false; save(root, file, value);
  }, /non-published package must be private/);
  expectFailure('layout-missing-local-lock', 'verify-layout.mjs', (root) => {
    rmSync(path.join(root, 'core/integration-tests/typescript-3.9/package-lock.json'));
  }, /npm lock placement mismatch/);
  expectFailure('layout-template-lock', 'verify-layout.mjs', (root) => {
    writeFileSync(path.join(root, 'frameworks/angular/integration-tests/typescript-versions/scaffold/package-lock.json'), '{}\n');
  }, /npm lock placement mismatch/);
  expectFailure('layout-yarn-lock', 'verify-layout.mjs', (root) => writeFileSync(path.join(root, 'yarn.lock'), ''), /forbidden current Yarn\/pnpm locks/);
  expectFailure('layout-symlink-manifest', 'verify-layout.mjs', (root) => {
    mkdirSync(path.join(root, 'rogue')); symlinkSync('../core/package.json', path.join(root, 'rogue/package.json'));
  }, /symbolic links are forbidden.*rogue\/package\.json/);
  expectFailure('layout-symlink-lock', 'verify-layout.mjs', (root) => {
    mkdirSync(path.join(root, 'core/rogue')); symlinkSync('../../package-lock.json', path.join(root, 'core/rogue/package-lock.json'));
  }, /symbolic links are forbidden.*core\/rogue\/package-lock\.json/);
  expectFailure('layout-lock-workspaces-drift', 'verify-layout.mjs', (root) => {
    const value = json(root, 'package-lock.json'); value.packages[''].workspaces = ['core']; save(root, 'package-lock.json', value);
  }, /root lock workspace declarations differ/);
  expectFailure('layout-stale-link', 'verify-layout.mjs', (root) => {
    const value = json(root, 'package-lock.json'); value.packages['node_modules/@uirouter/angular'].resolved = 'framework/angular/router'; save(root, 'package-lock.json', value);
  }, /root lock workspace link is invalid|stale pre-H03R/);

  expectFailure('deps-delete-current', 'verify-internal-deps.mjs', (root) => {
    const value = json(root, 'frameworks/react/examples/sample-app/package.json'); delete value.dependencies['@uirouter/react']; save(root, 'frameworks/react/examples/sample-app/package.json', value);
  }, /edge coverage mismatch/);
  expectFailure('deps-add-optional', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/react/examples/sample-app/package.json'; const value = json(root, file);
    value.optionalDependencies = { '@uirouter/rx': '^1.0.0' }; save(root, file, value);
  }, /unclassified current internal edge/);
  expectFailure('deps-move-section', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/react/examples/sample-app/package.json'; const value = json(root, file);
    value.devDependencies['@uirouter/react'] = value.dependencies['@uirouter/react']; delete value.dependencies['@uirouter/react']; save(root, file, value);
  }, /unclassified current internal edge/);
  expectFailure('deps-unsatisfied-range', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/react/examples/sample-app/package.json'; const value = json(root, file);
    value.dependencies['@uirouter/react'] = '^99.0.0'; save(root, file, value);
  }, /current spec .* != finalSpec|does not satisfy/);
  expectFailure('deps-workspace-registry-fallback', 'verify-internal-deps.mjs', (root) => {
    const value = json(root, 'package-lock.json'); value.packages['node_modules/@uirouter/react'] = { version: '1.0.8', resolved: 'https://registry.npmjs.org/@uirouter/react/-/react-1.0.8.tgz' }; save(root, 'package-lock.json', value);
  }, /root lock does not use a workspace link/);
  expectFailure('deps-local-link', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/@uirouter/core'] = { link: true, resolved: '../../../' }; save(root, file, value);
  }, /committed registry baseline is a workspace link/);
  expectFailure('deps-local-version', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/@uirouter/core'].version = '0.0.1'; save(root, file, value);
  }, /local lock version/);
  expectFailure('deps-local-file-origin', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/@uirouter/core'].resolved = 'file:../../../core'; save(root, file, value);
  }, /local lock origin file:.* != https:\/\/registry\.npmjs\.org\/@uirouter\/core/);
  expectFailure('deps-local-wrong-registry-package', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/@uirouter/core'].resolved = 'https://registry.npmjs.org/@uirouter/react/-/react-6.1.2.tgz'; save(root, file, value);
  }, /local lock origin .*react.* != .*core-6\.1\.2/);
  expectFailure('deps-local-missing-integrity', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package-lock.json'; const value = json(root, file);
    delete value.packages['node_modules/@uirouter/core'].integrity; save(root, file, value);
  }, /edge-core-integration-typescript-3-9-dependencies-uirouter-core: local lock has no valid 64-byte sha512 integrity/);
  expectFailure('deps-local-truncated-integrity', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/@uirouter/core'].integrity = 'sha512-AAAA'; save(root, file, value);
  }, /edge-core-integration-typescript-3-9-dependencies-uirouter-core: local lock has no valid 64-byte sha512 integrity/);
  expectFailure('deps-cross-lock-integrity-drift', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-5.4/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/@uirouter/core'].integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`; save(root, file, value);
  }, /edge-core-integration-typescript-5-4-dependencies-uirouter-core: integrity for @uirouter\/core@6\.1\.2 differs across committed locks/);
  expectFailure('deps-legacy-only-direct-committed-lock', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/react/integration-tests/react17/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/@uirouter/react'] = { version: '1.0.8' }; save(root, file, value);
  }, /edge-framework-react-integration-react17-legacy-injected-uirouter-react-react-versions-react17: forbidden legacy-only package in committed lock .*react17\/package-lock\.json: node_modules\/@uirouter\/react/);
  expectFailure('deps-legacy-only-nested-committed-lock', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/react/integration-tests/react17/package-lock.json'; const value = json(root, file);
    value.packages['node_modules/react/node_modules/@uirouter/react'] = { version: '1.0.8' }; save(root, file, value);
  }, /edge-framework-react-integration-react17-legacy-injected-uirouter-react-react-versions-react17: forbidden legacy-only package in committed lock .*react17\/package-lock\.json: node_modules\/react\/node_modules\/@uirouter\/react/);
  expectFailure('deps-local-workspace-spec', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package.json'; const value = json(root, file);
    value.dependencies['@uirouter/core'] = 'workspace:*'; save(root, file, value);
  }, /must retain source spec/);
  expectFailure('deps-published-file-spec', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/react/uirouter-react/package.json'; const value = json(root, file);
    value.dependencies['@uirouter/core'] = 'file:../../../core'; save(root, file, value);
  }, /current spec .* != finalSpec|publish-unsafe/);
  expectFailure('deps-delete-downstream', 'verify-internal-deps.mjs', (root) => {
    const file = 'plugins/dsr/downstream_projects.json'; const value = json(root, file);
    delete value.react['react-vite']; save(root, file, value);
  }, /edge coverage mismatch/);
  expectFailure('deps-change-downstream-key', 'verify-internal-deps.mjs', (root) => {
    const file = 'plugins/dsr/downstream_projects.json'; const value = json(root, file);
    value.react.renamed = value.react['react-vite']; delete value.react['react-vite']; save(root, file, value);
  }, /unclassified current downstream relationship/);
  expectFailure('deps-extra-downstream-config', 'verify-internal-deps.mjs', (root) => {
    mkdirSync(path.join(root, 'core/rogue')); save(root, 'core/rogue/downstream_projects.json', { rogue: './fixture' });
  }, /downstream config inventory mismatch.*core\/rogue\/downstream_projects\.json/);
  expectFailure('deps-unmapped-remote', 'verify-internal-deps.mjs', (root) => {
    const file = 'plugins/dsr/downstream_projects.json'; const value = json(root, file);
    value.react['react-vite'] = 'https://github.com/ui-router/not-imported.git'; save(root, file, value);
  }, /plugins\/dsr\/downstream_projects\.json:react\.react-vite: unmapped remote downstream/);
  expectFailure('deps-stale-downstream-path', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/react/uirouter-react/downstream_projects.json'; const value = json(root, file);
    value['react-versions'].react17 = './integration/react17'; save(root, file, value);
  }, /downstream destination has no classified manifest/);
  expectFailure('deps-fabricated-null-edge', 'verify-internal-deps.mjs', (root) => {
    const value = json(root, 'migration/package-classification.json'); value.edges.push({ ...value.edges.find((edge) => edge.declaredSpec === null), id: 'edge-fabricated' }); save(root, 'migration/package-classification.json', value);
  }, /expected 137 classified edges/);
  expectFailure('deps-root-override', 'verify-internal-deps.mjs', (root) => {
    const value = json(root, 'package.json'); value.overrides = { '@uirouter/angular': '22.0.0' }; save(root, 'package.json', value);
  }, /root overrides\/resolutions are forbidden/);
  expectFailure('deps-resolution-record-drift', 'verify-internal-deps.mjs', (root) => {
    const value = json(root, 'migration/package-classification.json'); value.resolutions[0].decision = 'isolated-integration'; save(root, 'migration/package-classification.json', value);
  }, /resolution decision .* != /);
  expectFailure('deps-workspace-dist-tag', 'verify-internal-deps.mjs', (root) => {
    const manifestFile = 'frameworks/react/examples/sample-app/package.json'; const manifest = json(root, manifestFile);
    manifest.dependencies['@uirouter/react'] = 'latest'; save(root, manifestFile, manifest);
    const contract = json(root, 'migration/package-classification.json');
    contract.edges.find((edge) => edge.id === 'edge-framework-react-examples-sample-app-dependencies-uirouter-react').finalSpec = 'latest';
    save(root, 'migration/package-classification.json', contract);
  }, /target 1\.0\.8 does not satisfy latest/);
  expectFailure('deps-workspace-malformed-range', 'verify-internal-deps.mjs', (root) => {
    const manifestFile = 'frameworks/react/examples/sample-app/package.json'; const manifest = json(root, manifestFile);
    manifest.dependencies['@uirouter/react'] = '^1.0.0 || nope'; save(root, manifestFile, manifest);
    const contract = json(root, 'migration/package-classification.json');
    contract.edges.find((edge) => edge.id === 'edge-framework-react-examples-sample-app-dependencies-uirouter-react').finalSpec = '^1.0.0 || nope';
    save(root, 'migration/package-classification.json', contract);
  }, /target 1\.0\.8 does not satisfy/);
  expectFailure('deps-angular-override-drift', 'verify-internal-deps.mjs', (root) => {
    const file = 'frameworks/angular/integration-tests/angular-versions/v22/package.json'; const value = json(root, file);
    value.overrides['@uirouter/angular']['@angular/core'] = '22.0.0'; save(root, file, value);
  }, /override differs from approved exact shape/);
  expectFailure('deps-yarn-resolution', 'verify-internal-deps.mjs', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.resolutions = { chokidar: '3.6.0' }; save(root, file, value);
  }, /current Yarn resolutions are forbidden/);
  expectSuccess('deps-ignore-n03-counters', 'verify-internal-deps.mjs', (root) => {
    const file = 'migration/evidence/n03/install-proof.json'; const value = json(root, file);
    value.summary = { fabricatedCounter: 999 }; save(root, file, value);
  }, /INTERNAL_DEPS_VERIFY_OK current=109 legacy=28/);

  console.log(`N04_VALIDATOR_ADVERSARIAL_TESTS_OK cases=${passed}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
