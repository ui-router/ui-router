#!/usr/bin/env node

import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '..');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'uirouter-n05-negative-'));
const json = (root, file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const save = (root, file, value) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (root, file) => createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex');
let passed = 0;

function checkout(name) {
  const root = path.join(tempRoot, name);
  cpSync(source, root, {
    recursive: true,
    filter: (entry) => !['.git', 'node_modules'].includes(path.basename(entry)),
  });
  return root;
}

function run(root) {
  return spawnSync(process.execPath, ['tools/verify-package-manager.mjs'], { cwd: root, encoding: 'utf8' });
}

function expectFailure(name, mutate, expected) {
  const root = checkout(name);
  mutate(root);
  const result = run(root);
  const output = `${result.stdout}${result.stderr}`;
  if (result.status === 0) throw new Error(`${name}: validator unexpectedly passed`);
  if (!expected.test(output)) throw new Error(`${name}: expected ${expected}, got:\n${output}`);
  passed += 1;
}

function expectSuccess(name, mutate, expected) {
  const root = checkout(name);
  mutate(root);
  const result = run(root);
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0 || !expected.test(output)) throw new Error(`${name}: expected success ${expected}, got:\n${output}`);
  passed += 1;
}

try {
  expectSuccess('baseline', () => {}, /PACKAGE_MANAGER_VERIFY_OK/);
  expectFailure('root-yarn-package-manager', (root) => {
    const value = json(root, 'package.json'); value.packageManager = 'yarn@1.22.22'; save(root, 'package.json', value);
  }, /root package manager/);
  expectFailure('root-pnpm-package-manager', (root) => {
    const value = json(root, 'package.json'); value.packageManager = 'pnpm@10.0.0'; save(root, 'package.json', value);
  }, /root package manager/);
  expectFailure('nested-package-manager', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.packageManager = 'npm@11.17.0'; save(root, file, value);
  }, /nested packageManager declaration/);
  expectFailure('angular-cli-other-package-manager', (root) => {
    const file = 'frameworks/angular/uirouter-angular/angular.json'; const value = json(root, file); value.cli.packageManager = 'bun'; save(root, file, value);
  }, /Angular CLI package manager/);
  expectFailure('yarn-lock', (root) => writeFileSync(path.join(root, 'yarn.lock'), ''), /forbidden current package-manager artifact/);
  expectFailure('pnpm-lock', (root) => writeFileSync(path.join(root, 'pnpm-lock.yaml'), ''), /forbidden current package-manager artifact/);
  expectFailure('yarn-config', (root) => writeFileSync(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n'), /forbidden current package-manager artifact/);
  expectFailure('empty-yalc-lock', (root) => writeFileSync(path.join(root, 'yalc.lock'), ''), /forbidden current package-manager artifact/);
  expectFailure('populated-yalc-lock', (root) => writeFileSync(path.join(root, 'yalc.lock'), '{"lockfileVersion": 1}\n'), /forbidden current package-manager artifact/);
  expectFailure('yalc-directory', (root) => mkdirSync(path.join(root, '.yalc')), /forbidden current package-manager directory/);
  expectFailure('yarn-directory', (root) => mkdirSync(path.join(root, '.yarn')), /forbidden current package-manager directory/);
  expectFailure('active-nested-workflow', (root) => {
    cpSync(path.join(root, 'core/.github/workflows/ci.yml.legacy'), path.join(root, 'core/.github/workflows/ci.yml'));
  }, /active source-era workflow remains/);
  expectFailure('active-travis', (root) => {
    cpSync(path.join(root, 'plugins/redux/.travis.yml.legacy'), path.join(root, 'plugins/redux/.travis.yml'));
  }, /active source-era Travis configuration remains/);
  expectFailure('active-dependency-action', (root) => {
    cpSync(path.join(root, 'tools/publish-scripts/actions/upgrade/action.yml.legacy'), path.join(root, 'tools/publish-scripts/actions/upgrade/action.yml'));
  }, /active source-era dependency action remains/);
  expectFailure('active-dependency-config', (root) => {
    cpSync(path.join(root, 'frameworks/react/uirouter-react/.github/dependabot.yml.legacy'), path.join(root, 'frameworks/react/uirouter-react/.github/dependabot.yml'));
  }, /active source-era dependency automation remains/);
  expectFailure('yarn-package-script', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.evil = 'yarn test'; save(root, file, value);
  }, /forbidden package-manager command/);
  expectFailure('pnpm-package-script', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.evil = 'pnpm install'; save(root, file, value);
  }, /forbidden package-manager command/);
  expectFailure('yarnpkg-package-script', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.evil = 'yarnpkg test'; save(root, file, value);
  }, /forbidden package-manager command/);
  expectFailure('corepack-package-script', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.evil = 'corepack yarn test'; save(root, file, value);
  }, /forbidden package-manager command/);
  expectFailure('split-package-manager-command', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.evil = "y''arn install"; save(root, file, value);
  }, /forbidden package-manager command/);
  expectFailure('expanded-package-manager-command', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.evil = 'y${EMPTY}arn install'; save(root, file, value);
  }, /forbidden package-manager command/);
  expectFailure('yalc-dependency', (root) => {
    const file = 'tools/publish-scripts/package.json'; const value = json(root, file); value.dependencies.yalc = '^1.0.0'; save(root, file, value);
  }, /forbidden dependency yalc/);
  expectFailure('yarnpkg-dependency', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.dependencies = { ...(value.dependencies ?? {}), '@yarnpkg/lockfile': '^1.1.0' }; save(root, file, value);
  }, /forbidden dependency @yarnpkg\/lockfile/);
  expectFailure('yarn-resolutions', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.resolutions = { chokidar: '3.6.0' }; save(root, file, value);
  }, /Yarn resolutions field remains/);
  expectFailure('pnpm-manifest-config', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.pnpm = { overrides: {} }; save(root, file, value);
  }, /pnpm configuration remains/);
  expectFailure('prepare-lifecycle', (root) => {
    const file = 'frameworks/react/uirouter-react/package.json'; const value = json(root, file); value.scripts.prepare = 'husky'; save(root, file, value);
  }, /implicit lifecycle script remains/);
  expectFailure('prepublish-lifecycle', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.prepublishOnly = 'npm run build'; save(root, file, value);
  }, /implicit lifecycle script remains/);
  expectFailure('postinstall-lifecycle', (root) => {
    const file = 'plugins/dsr/examples/react-vite/package.json'; const value = json(root, file); value.scripts.postinstall = 'npm exec -- playwright install chromium'; save(root, file, value);
  }, /implicit lifecycle script remains/);
  expectFailure('unsafe-install-script', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.setup = 'npm install'; save(root, file, value);
  }, /install command lacks --ignore-scripts/);
  expectFailure('fabricated-downstream-invocation', (root) => {
    const file = 'plugins/rx/package.json'; const value = json(root, file); value.scripts['test:downstream'] = 'test_downstream_projects'; save(root, file, value);
  }, /unapproved source-era helper invocation/);
  expectFailure('indirect-downstream-package-script', (root) => {
    const file = 'core/package.json'; const value = json(root, file); value.scripts.ci = 'npm run test:downstream'; save(root, file, value);
  }, /indirect retired-script invocation/);
  expectFailure('indirect-downstream-shell-script', (root) => {
    const file = path.join(root, 'rogue.sh'); writeFileSync(file, '#!/usr/bin/env bash\nnpm --workspace @uirouter/core run test:downstream\n'); chmodSync(file, 0o755);
  }, /unallowlisted retired-script invocation/);
  expectFailure('disabled-downstream-drift', (root) => {
    const file = 'core/package.json'; const value = json(root, file); delete value.scripts['test:downstream']; save(root, file, value);
  }, /disabled test:downstream/);
  expectFailure('legacy-bin-reroute', (root) => {
    const file = 'tools/publish-scripts/package.json'; const value = json(root, file); value.bin.test_downstream_projects = './test_downstream_projects.legacy.js'; save(root, file, value);
  }, /unapproved source-era binary/);
  expectFailure('extra-legacy-bin', (root) => {
    const file = 'tools/publish-scripts/package.json'; const value = json(root, file); value.bin.yalc = './publish_yalc_package.js'; save(root, file, value);
  }, /unapproved source-era binary/);
  expectFailure('downstream-stub-mutation', (root) => {
    writeFileSync(path.join(root, 'tools/publish-scripts/test_downstream_projects.js'), '#!/usr/bin/env node\nrequire("./test_downstream_projects.legacy.js");\n');
  }, /allowlist hash|downstream fail-closed stub/);
  expectFailure('docs-stub-mutation', (root) => {
    writeFileSync(path.join(root, 'tools/publish-scripts/docgen_via_docker.sh'), '#!/usr/bin/env bash\nnpm install\n');
  }, /allowlist hash|docs container fail-closed stub/);
  expectFailure('legacy-executable-bit', (root) => {
    chmodSync(path.join(root, 'tools/publish-scripts/test_downstream_projects.legacy.js'), 0o755);
  }, /executable disposition|legacy file remains executable/);
  expectFailure('unlisted-legacy-file', (root) => {
    writeFileSync(path.join(root, 'core/rogue.yml.legacy'), 'run: yarn install\n');
  }, /explicit legacy inventory/);
  expectFailure('historical-file-drift', (root) => {
    writeFileSync(path.join(root, 'core/CHANGELOG.md'), `${readFileSync(path.join(root, 'core/CHANGELOG.md'))}\nyarn install\n`);
  }, /allowlist hash/);
  expectFailure('colluding-allowlist-rehash', (root) => {
    const file = 'core/CHANGELOG.md'; writeFileSync(path.join(root, file), `${readFileSync(path.join(root, file))}\nyarn install\n`);
    const value = json(root, 'migration/evidence/n05/package-manager-allowlist.json'); value.entries.find((entry) => entry.path === file).sha256 = sha256(root, file);
    save(root, 'migration/evidence/n05/package-manager-allowlist.json', value);
  }, /approved allowlist digest/);
  expectFailure('allowlist-duplicate', (root) => {
    const file = 'migration/evidence/n05/package-manager-allowlist.json'; const value = json(root, file); value.entries.push(value.entries[0]); save(root, file, value);
  }, /approved allowlist digest/);
  expectFailure('allowlist-owner', (root) => {
    const file = 'migration/evidence/n05/package-manager-allowlist.json'; const value = json(root, file); value.owner = 'nobody'; save(root, file, value);
  }, /approved allowlist digest/);
  expectFailure('legacy-workflow-owner', (root) => {
    const file = 'migration/evidence/n05/package-manager-allowlist.json'; const value = json(root, file); value.entries.find((entry) => entry.category === 'source-workflow').replacementTask = 'I02'; save(root, file, value);
  }, /approved allowlist digest/);
  expectFailure('unallowlisted-doc-command', (root) => {
    writeFileSync(path.join(root, 'README-rogue.md'), 'Run `yarn install` from the repository root.\n');
  }, /unallowlisted package-manager occurrence/);
  expectFailure('unallowlisted-shell-command', (root) => {
    const file = path.join(root, 'rogue.sh'); writeFileSync(file, '#!/usr/bin/env bash\npnpm install\n'); chmodSync(file, 0o755);
  }, /unallowlisted package-manager occurrence/);
  expectFailure('unsafe-shell-install', (root) => {
    const file = path.join(root, 'rogue.sh'); writeFileSync(file, '#!/usr/bin/env bash\nnpm install\n'); chmodSync(file, 0o755);
  }, /active install command lacks --ignore-scripts/);
  expectFailure('migration-executable', (root) => chmodSync(path.join(root, 'migration/validation.md'), 0o755), /migration control\/evidence file is executable/);
  expectFailure('migration-script', (root) => {
    const file = path.join(root, 'migration/rogue.sh'); writeFileSync(file, '#!/usr/bin/env bash\nnpm install\n'); chmodSync(file, 0o644);
  }, /unexpected migration control\/evidence path/);
  expectFailure('root-lock-yarn-package', (root) => {
    const file = 'package-lock.json'; const value = json(root, file); value.packages['node_modules/yarn'] = { version: '1.22.22' }; save(root, file, value);
  }, /Turbo current lock digest|forbidden package-manager package/);
  expectFailure('colluding-root-lock-evidence', (root) => {
    const lockPath = 'package-lock.json'; const lock = json(root, lockPath); lock.packages['node_modules/yalc'] = { version: '1.0.0' }; save(root, lockPath, lock);
    const evidencePath = 'migration/evidence/n05/package-manager-cleanup.json'; const evidence = json(root, evidencePath);
    evidence.rootLock.afterSha256 = sha256(root, lockPath); evidence.rootLock.afterPackageEntries += 1;
    evidence.rootLock.addedPackageKeys = ['node_modules/yalc']; save(root, evidencePath, evidence);
  }, /approved cleanup evidence digest/);
  expectFailure('local-lock-pnpm-package', (root) => {
    const file = 'core/integration-tests/typescript-3.9/package-lock.json'; const value = json(root, file); value.packages['node_modules/pnpm'] = { version: '10.0.0' }; save(root, file, value);
  }, /forbidden package-manager package/);
  expectFailure('symlinked-package-manager-path', (root) => {
    symlinkSync('package.json', path.join(root, 'rogue-link'));
  }, /package-manager inventory path is a symlink/);

  console.log(`N05_PACKAGE_MANAGER_ADVERSARIAL_TESTS_OK cases=${passed}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
