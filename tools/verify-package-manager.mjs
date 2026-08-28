#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};
const stable = (value) => JSON.stringify(value ?? null);
const requireEqual = (label, actual, expected) => {
  if (stable(actual) !== stable(expected)) fail(`${label}: expected ${stable(expected)}, got ${stable(actual)}`);
};
const readBytes = (path) => readFileSync(join(root, path));
const readText = (path) => readBytes(path).toString('utf8');
const readJson = (path) => JSON.parse(readText(path));
const sha256 = (path) => createHash('sha256').update(readBytes(path)).digest('hex');
const normalized = (path) => relative(root, path).split(sep).join('/');
const packageArtifactsContract = readJson('migration/package-artifacts.json');
const ignoredGeneratedDirectories = new Set(packageArtifactsContract.packages.flatMap((record) => {
  const packageDirectory = dirname(record.manifest).split(sep).join('/');
  return [
    ...(record.build?.cleanPaths || []).map((cleanPath) => `${packageDirectory}/${cleanPath}`),
    `${packageDirectory}/${packageArtifactsContract.artifactPolicy.directory}`,
  ];
}));

const ignoredDirectories = new Set(['.artifacts', '.git', '.turbo', 'node_modules']);
const forbiddenDirectories = new Set(['.pnpm-store', '.yalc', '.yarn']);
const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (forbiddenDirectories.has(entry.name)) fail(`forbidden current package-manager directory: ${normalized(join(directory, entry.name))}`);
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const info = lstatSync(absolute);
    const path = normalized(absolute);
    if (info.isDirectory() && ignoredGeneratedDirectories.has(path)) continue;
    if (info.isSymbolicLink()) fail(`package-manager inventory path is a symlink: ${path}`);
    if (info.isDirectory()) walk(absolute);
    else if (info.isFile()) files.push(path);
  }
};
walk(root);
files.sort();

const rootPackage = readJson('package.json');
requireEqual('root package manager', rootPackage.packageManager, 'npm@11.17.0');
requireEqual('root runtime engine', rootPackage.devEngines?.runtime, { name: 'node', version: '24.19.0', onFail: 'error' });
requireEqual('root package-manager engine', rootPackage.devEngines?.packageManager, { name: 'npm', version: '11.17.0', onFail: 'error' });

const cleanupEvidencePath = 'migration/evidence/n05/package-manager-cleanup.json';
requireEqual('approved cleanup evidence digest', sha256(cleanupEvidencePath), 'c79098272e690258cfb6dfe235c0149e3cb7f4bd81ce2ee9ae6fc9d6705c894d');
const cleanupEvidence = readJson(cleanupEvidencePath);
requireEqual('cleanup evidence task', cleanupEvidence.task, 'N05');
requireEqual('cleanup evidence owner', cleanupEvidence.owner, 'ui-router-maintainers');
requireEqual('cleanup evidence base', cleanupEvidence.baseCommit, '40e57e908a95b74fcc12f19e689ba7f0986a59a7');
requireEqual('cleanup evidence runtime', cleanupEvidence.runtime, {
  node: 'v24.19.0',
  npm: '11.17.0',
  imageDigest: 'sha256:56ab6ddaab798f0664b18448a1226bfa9e43aefaa90af280ff79d05c350a2ef8',
});
const n03Evidence = readJson('migration/evidence/n03/lock-conversion.json');
requireEqual('cleanup lock predecessor', cleanupEvidence.rootLock.beforeSha256, n03Evidence.rootLock.sha256);
requireEqual('cleanup lock predecessor entries', cleanupEvidence.rootLock.beforePackageEntries, n03Evidence.rootLock.packageEntries);
requireEqual('cleanup added lock keys', cleanupEvidence.rootLock.addedPackageKeys, []);
const turboEvidencePath = 'migration/evidence/s03/turbo-graph.json';
requireEqual('approved S03 Turbo evidence digest', sha256(turboEvidencePath), '3362046ab45dc9400ca16a026b0d478d9ce57e26bc1901bbabf6018b4b6f1bbd');
const turboEvidence = readJson(turboEvidencePath);
requireEqual('Turbo evidence schema version', turboEvidence.schemaVersion, 1);
requireEqual('Turbo evidence task', turboEvidence.task, 'S03');
requireEqual('Turbo evidence owner', turboEvidence.owner, 'ui-router-maintainers');
requireEqual('Turbo evidence base', turboEvidence.baseCommit, '25e382a7994268f37411f4dfaa5a97ce3e2fa2d3');
requireEqual('Turbo evidence runtime', turboEvidence.runtime, cleanupEvidence.runtime);
requireEqual('Turbo lock predecessor digest', turboEvidence.rootLock.beforeSha256, cleanupEvidence.rootLock.afterSha256);
requireEqual('Turbo lock predecessor entries', turboEvidence.rootLock.beforePackageEntries, cleanupEvidence.rootLock.afterPackageEntries);
requireEqual('P01 lock predecessor digest', packageArtifactsContract.rootLockPredecessorSha256, turboEvidence.rootLock.afterSha256);
requireEqual('P01 current lock digest', packageArtifactsContract.rootLockSha256, sha256('package-lock.json'));
const currentRootLock = readJson('package-lock.json');
requireEqual('P01 current lock entries', Object.keys(currentRootLock.packages).length, turboEvidence.rootLock.afterPackageEntries + 5);
const reactHybridManifest = readJson('frameworks/react-hybrid/uirouter-react-hybrid/package.json');
const reduxManifest = readJson('plugins/redux/package.json');
requireEqual('P01 React Hybrid lock record', currentRootLock.packages['frameworks/react-hybrid/uirouter-react-hybrid'].devDependencies, reactHybridManifest.devDependencies);
requireEqual('P01 Redux peer lock record', currentRootLock.packages['plugins/redux'].peerDependencies, reduxManifest.peerDependencies);
requireEqual('P01 Redux optional peer lock record', currentRootLock.packages['plugins/redux'].peerDependenciesMeta, reduxManifest.peerDependenciesMeta);
for (const [key, version] of Object.entries({
  'frameworks/react-hybrid/uirouter-react-hybrid/node_modules/@types/react': '19.2.18',
  'frameworks/react-hybrid/uirouter-react-hybrid/node_modules/@types/react-dom': '19.2.5',
  'frameworks/react-hybrid/uirouter-react-hybrid/node_modules/react': '19.2.8',
  'frameworks/react-hybrid/uirouter-react-hybrid/node_modules/react-dom': '19.2.8',
  'node_modules/typescript-p01': '5.9.3',
})) requireEqual(`P01 changed lock package ${key}`, currentRootLock.packages[key]?.version, version);
requireEqual('P01 TypeScript tool alias declaration', rootPackage.devDependencies['typescript-p01'], 'npm:typescript@5.9.3');
requireEqual('Turbo added lock keys', turboEvidence.rootLock.addedPackageKeys, [
  'node_modules/@turbo/darwin-64',
  'node_modules/@turbo/darwin-arm64',
  'node_modules/@turbo/linux-64',
  'node_modules/@turbo/linux-arm64',
  'node_modules/@turbo/windows-64',
  'node_modules/@turbo/windows-arm64',
  'node_modules/turbo',
]);
requireEqual('Turbo evidence package', turboEvidence.turbo, {
  version: '2.10.12',
  integrity: 'sha512-AswgMPnpOoaVZHrrSBejETzEbuIA69OVGwfkHwfrY0A23VjWXBANzgq9+OymWOHAIArB7D1+1z498WY8fGg1Jw==',
  remoteCache: false,
});
requireEqual('cleanup install command', cleanupEvidence.installProof.command, 'npm ci --ignore-scripts --no-audit --no-fund');
requireEqual('cleanup install status', cleanupEvidence.installProof.exitStatus, 0);
requireEqual('cleanup external sandbox', cleanupEvidence.installProof.sandboxOutsideRepositoryAncestry, true);
requireEqual('cleanup forbidden installed packages', cleanupEvidence.installProof.forbiddenInstalledPackagesAbsent, [
  'node_modules/yalc',
  'node_modules/@yarnpkg',
]);
requireEqual('cleanup disabled stub statuses', cleanupEvidence.installProof.disabledStubExitStatuses, {
  'tools/publish-scripts/test_downstream_projects.js': 1,
  'tools/publish-scripts/publish_yalc_package.js': 1,
  'tools/publish-scripts/docgen_via_docker.sh': 1,
});
requireEqual('cleanup validation summary', cleanupEvidence.validation, {
  cleanTreeCheck: 'PACKAGE_MANAGER_VERIFY_OK manifests=45 angularConfigs=9 allowlisted=63 legacy=42 scanned=1044',
  adversarialCheck: 'N05_PACKAGE_MANAGER_ADVERSARIAL_TESTS_OK cases=54',
});

const allowlistPath = 'migration/evidence/n05/package-manager-allowlist.json';
requireEqual('approved allowlist digest', sha256(allowlistPath), '2df0709232ce8e3beb379d141cbc3f4a59d09b3103784d14c48997ed6b3754e5');
const allowlist = readJson(allowlistPath);
requireEqual('allowlist schema version', allowlist.schemaVersion, 1);
requireEqual('allowlist task', allowlist.task, 'N05');
requireEqual('allowlist owner', allowlist.owner, 'ui-router-maintainers');
requireEqual('allowlist base', allowlist.baseCommit, '40e57e908a95b74fcc12f19e689ba7f0986a59a7');
const allowedCategories = new Set([
  'dependency-action',
  'disabled-metadata',
  'enforcement-guard',
  'historical-changelog',
  'original-draft',
  'source-helper',
  'source-workflow',
  'vendored-source',
]);
const allowedEntries = new Map();
for (const entry of allowlist.entries) {
  if (allowedEntries.has(entry.path)) fail(`duplicate allowlist path: ${entry.path}`);
  if (!files.includes(entry.path)) fail(`allowlist path is missing: ${entry.path}`);
  if (!allowedCategories.has(entry.category)) fail(`unknown allowlist category for ${entry.path}: ${entry.category}`);
  if (!entry.reason || typeof entry.reason !== 'string') fail(`allowlist reason is missing: ${entry.path}`);
  if (entry.path === 'tools/publish-scripts/util.js') {
    requireEqual('P01 predecessor util.js allowlist hash', entry.sha256, '927500e30b88271b2f30aa5d16911404b76cbba92d2d621f2abb0e5eb981d6dc');
    requireEqual('P01 executable util.js hash', sha256(entry.path), '25368d23bb89f4c60401191dd117d6b9ea632b8e3e42e84e683238839f4e8acd');
  } else requireEqual(`${entry.path} allowlist hash`, sha256(entry.path), entry.sha256);
  requireEqual(`${entry.path} executable disposition`, Boolean(statSync(join(root, entry.path)).mode & 0o111), entry.executable);
  if (entry.path.includes('.legacy') && entry.executable) fail(`legacy file remains executable: ${entry.path}`);
  if (entry.replacementTask) {
    requireEqual(`${entry.path} disabled disposition`, entry.disposition, 'disabled');
    requireEqual(`${entry.path} waiver expiry`, entry.expiresOn, '2026-09-30');
  }
  if (entry.category === 'source-workflow' && entry.replacementTask !== 'C01') fail(`source workflow lacks C01 ownership: ${entry.path}`);
  if (entry.category === 'dependency-action' && entry.replacementTask !== 'C01') fail(`dependency action lacks C01 ownership: ${entry.path}`);
  if (entry.path.includes('test_downstream_projects') && entry.category === 'source-helper' && entry.replacementTask !== 'I02') {
    fail(`downstream helper lacks I02 ownership: ${entry.path}`);
  }
  if (entry.path.includes('publish_yalc_package') && entry.category === 'source-helper' && entry.replacementTask !== 'I02') {
    fail(`package transport helper lacks I02 ownership: ${entry.path}`);
  }
  allowedEntries.set(entry.path, entry);
}
requireEqual('allowlist path ordering', allowlist.entries.map((entry) => entry.path), [...allowedEntries.keys()].sort());

const legacyFiles = files.filter((path) => path.includes('.legacy'));
requireEqual(
  'explicit legacy inventory',
  legacyFiles,
  allowlist.entries.filter((entry) => entry.path.includes('.legacy')).map((entry) => entry.path),
);

const forbiddenLockBasenames = new Set([
  '.pnp.cjs',
  '.pnp.js',
  '.yarnclean',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pnpmfile.cjs',
  'yalc.lock',
  'yarn.lock',
]);
const reviewedWorkflows = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/reproducibility.yml',
]);
for (const path of files) {
  const basename = path.split('/').at(-1);
  if (forbiddenLockBasenames.has(basename)) fail(`forbidden current package-manager artifact: ${path}`);
  if (/(^|\/)\.github\/workflows\/.*\.(?:yml|yaml)$/.test(path) && !reviewedWorkflows.has(path)) {
    fail(`active source-era workflow remains: ${path}`);
  }
  if (basename === '.travis.yml') fail(`active source-era Travis configuration remains: ${path}`);
  if (['dependabot.yml', 'dependabot.yaml', 'dependencies.yml', 'dependencies.yaml'].includes(basename)) {
    fail(`active source-era dependency automation remains: ${path}`);
  }
  if ((basename === 'action.yml' || basename === 'action.yaml') && path.startsWith('tools/publish-scripts/actions/')) {
    fail(`active source-era dependency action remains: ${path}`);
  }
}

const disabledDownstreamScripts = new Map(Object.entries({
  'core/package.json': { 'test:downstream': 'test_downstream_projects' },
  'frameworks/angular-hybrid/uirouter-angular-hybrid/package.json': { 'test:downstream': 'npm run build && test_downstream_projects' },
  'frameworks/angular/uirouter-angular/package.json': { 'test:downstream': 'test_downstream_projects' },
  'frameworks/angularjs/uirouter-angularjs/package.json': { 'test:downstream': 'test_downstream_projects' },
  'frameworks/react-hybrid/uirouter-react-hybrid/package.json': { 'test:downstream': 'test_downstream_projects' },
  'frameworks/react/uirouter-react/package.json': {
    'test:downstream': 'npm run build && test_downstream_projects',
    'test:integration': 'npm run build && test_downstream_projects --group=react-versions',
  },
  'plugins/dsr/package.json': { 'test:downstream': 'test_downstream_projects' },
  'plugins/sticky-states/package.json': { 'test:downstream': 'npm run build && test_downstream_projects' },
}));
const implicitLifecycleScripts = new Set([
  'dependencies',
  'install',
  'postinstall',
  'postpack',
  'postpublish',
  'preinstall',
  'prepack',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'publish',
]);
const forbiddenCommand = /\byarn(?:pkg)?\b|\bpnpm\b|\byalc\b|@yarnpkg\/|\bcorepack\b/i;
const normalizedCommandText = (text) => text.replace(/\$\{[^}]*\}/g, '').replace(/["'\\]/g, '');
const hasForbiddenCommand = (text) => forbiddenCommand.test(text) || forbiddenCommand.test(normalizedCommandText(text));
const legacyCommand = /test_downstream_projects|publish_yalc_package/i;
const retiredScriptInvocation = /\btest:(?:downstream|integration)\b/i;
const installCommand = /\bnpm\s+(?:ci|i|install|update)\b/i;
const packageManifests = files.filter((path) => path.endsWith('/package.json') || path === 'package.json');
for (const path of packageManifests) {
  if (path.startsWith('archive/')) continue;
  const manifest = readJson(path);
  if (path !== 'package.json' && Object.hasOwn(manifest, 'packageManager')) fail(`nested packageManager declaration: ${path}`);
  if (Object.hasOwn(manifest, 'resolutions')) fail(`Yarn resolutions field remains: ${path}`);
  if (Object.hasOwn(manifest, 'pnpm')) fail(`pnpm configuration remains: ${path}`);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (/^(?:yarn|pnpm|yalc|@yarnpkg\/)/i.test(dependency)) fail(`forbidden dependency ${dependency} in ${path} ${section}`);
    }
  }
  const approved = disabledDownstreamScripts.get(path) ?? {};
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (implicitLifecycleScripts.has(name)) fail(`implicit lifecycle script remains: ${path} scripts.${name}`);
    if (hasForbiddenCommand(command)) fail(`forbidden package-manager command: ${path} scripts.${name}`);
    if (legacyCommand.test(command) && approved[name] !== command) fail(`unapproved source-era helper invocation: ${path} scripts.${name}`);
    if (retiredScriptInvocation.test(command)) fail(`indirect retired-script invocation: ${path} scripts.${name}`);
    if (installCommand.test(command) && !/--ignore-scripts\b/.test(command)) fail(`install command lacks --ignore-scripts: ${path} scripts.${name}`);
  }
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    if (hasForbiddenCommand(`${name} ${target}`) || legacyCommand.test(`${name} ${target}`)) {
      const permitted = path === 'tools/publish-scripts/package.json' &&
        ((name === 'test_downstream_projects' && target === './test_downstream_projects.js') ||
          (name === 'publish_yalc_package' && target === './publish_yalc_package.js'));
      if (!permitted) fail(`unapproved source-era binary: ${path} bin.${name}`);
    }
  }
}
for (const [path, scripts] of disabledDownstreamScripts) {
  const actual = readJson(path).scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) requireEqual(`${path} disabled ${name}`, actual[name], command);
}
const angularConfigs = files.filter((path) => path.endsWith('/angular.json'));
let angularPackageManagerFields = 0;
const inspectAngularConfig = (value, path) => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'packageManager') {
      requireEqual(`${path} Angular CLI package manager`, child, 'npm');
      angularPackageManagerFields += 1;
    }
    inspectAngularConfig(child, path);
  }
};
for (const path of angularConfigs) inspectAngularConfig(readJson(path), path);
requireEqual('Angular CLI package-manager field count', angularPackageManagerFields, 5);
requireEqual('disabled dependency-action metadata', readJson('tools/publish-scripts/actions/upgrade/package.json'), {
  name: '@uirouter/internal-tools-publish-scripts-actions-upgrade',
  private: true,
  version: '1.0.0',
  dependencies: {},
});
requireEqual(
  'downstream fail-closed stub',
  readText('tools/publish-scripts/test_downstream_projects.js'),
  "#!/usr/bin/env node\n'use strict';\n\nconsole.error('This source-era downstream helper is disabled. Task I02 will provide the npm integration runner.');\nprocess.exit(1);\n",
);
requireEqual(
  'package transport fail-closed stub',
  readText('tools/publish-scripts/publish_yalc_package.js'),
  "#!/usr/bin/env node\n'use strict';\n\nconsole.error('This source-era package transport is disabled. Task I02 will provide content-addressed npm tarballs.');\nprocess.exit(1);\n",
);
requireEqual(
  'docs container fail-closed stub',
  readText('tools/publish-scripts/docgen_via_docker.sh'),
  "#!/usr/bin/env bash\nset -euo pipefail\n\necho 'This source-era docs container is disabled pending deterministic packaging task P01.' >&2\nexit 1\n",
);

for (const path of files.filter((path) => path.endsWith('package-lock.json'))) {
  const lock = readJson(path);
  if (lock.lockfileVersion !== 3) fail(`non-v3 npm lock: ${path}`);
  for (const key of Object.keys(lock.packages ?? {})) {
    const packageName = key.replace(/^.*node_modules\//, '');
    if (/^(?:yarn|pnpm|yalc|@yarnpkg\/)/i.test(packageName)) fail(`forbidden package-manager package in ${path}: ${key}`);
  }
}

const policyPaths = new Set([
  'SPEC.md',
  'tools/clean-reproducibility-lib.mjs',
  'tools/ci-gates-lib.mjs',
  'tools/prove-clean-reproducibility.mjs',
  'tools/render-ci-workflow.mjs',
  'tools/render-reproducibility-workflow.mjs',
  'tools/test-ci-gates.mjs',
  'tools/test-clean-reproducibility.mjs',
  'tools/verify-ci-gates.mjs',
  'tools/verify-clean-reproducibility.mjs',
  'tools/test-isolated-projects.mjs',
  'tools/test-n05-package-manager.mjs',
  'tools/verify-isolated-projects.mjs',
  'tools/verify-package-manager.mjs',
]);
const migrationControlFiles = new Set([
  'migration/baselines.json',
  'migration/ci-gates.json',
  'migration/clean-reproducibility.json',
  'migration/execution-lock.json',
  'migration/import-lock.json',
  'migration/integration-matrix.json',
  'migration/isolated-projects.json',
  'migration/package-artifacts.json',
  'migration/package-classification.json',
  'migration/path-repairs.json',
  'migration/README.md',
  'migration/sources.json',
  'migration/source-aliases.json',
  'migration/validation.md',
  'migration/work-graph.json',
]);
const isMigrationControl = (path) => migrationControlFiles.has(path) || path.startsWith('migration/evidence/') || path.startsWith('migration/schemas/');
const textExtensions = new Set(['', '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.sh', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
const extension = (path) => {
  const basename = path.split('/').at(-1);
  const index = basename.lastIndexOf('.');
  return index === -1 ? '' : basename.slice(index);
};
let scannedFiles = 0;
for (const path of files) {
  if (allowedEntries.has(path) || policyPaths.has(path) || path.endsWith('package-lock.json') || packageManifests.includes(path)) continue;
  if (path === allowlistPath) continue;
  if (path.startsWith('migration/')) {
    if (!isMigrationControl(path)) fail(`unexpected migration control/evidence path: ${path}`);
    if (statSync(join(root, path)).mode & 0o111) fail(`migration control/evidence file is executable: ${path}`);
    const basename = path.split('/').at(-1);
    if (!['.json', '.log', '.md'].includes(extension(path)) && basename !== 'commit-map') fail(`unexpected migration control/evidence file type: ${path}`);
    if (basename === 'package.json') fail(`migration control/evidence contains a package manifest: ${path}`);
    continue;
  }
  if (!textExtensions.has(extension(path))) continue;
  const bytes = readBytes(path);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  if (hasForbiddenCommand(text) || legacyCommand.test(text)) fail(`unallowlisted package-manager occurrence: ${path}`);
  if (retiredScriptInvocation.test(text)) fail(`unallowlisted retired-script invocation: ${path}`);
  if ((path.endsWith('.sh') || Boolean(statSync(join(root, path)).mode & 0o111)) && installCommand.test(text) && !/--ignore-scripts\b/.test(text)) {
    fail(`active install command lacks --ignore-scripts: ${path}`);
  }
  scannedFiles += 1;
}

console.log(`PACKAGE_MANAGER_VERIFY_OK manifests=${packageManifests.length} angularConfigs=${angularConfigs.length} allowlisted=${allowlist.entries.length} legacy=${legacyFiles.length} scanned=${scannedFiles}`);
