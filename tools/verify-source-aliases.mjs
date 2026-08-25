#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

const root = realpathSync(path.resolve(argument('--root') ?? path.join(import.meta.dirname, '..')));
const contractOnly = process.argv.includes('--contract-only');
const productionOnly = process.argv.includes('--production');
const selectedEdge = argument('--edge');
const fail = (message) => { throw new Error(`SOURCE_ALIASES_VERIFY_FAILED: ${message}`); };
const readText = (relative) => readFileSync(path.join(root, relative), 'utf8');
const readJson = (relative) => JSON.parse(readText(relative));
const sha256 = (relative) => createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex');
const contract = readJson('migration/source-aliases.json');
const classification = readJson('migration/package-classification.json');
const repairs = readJson('migration/path-repairs.json');
const baselines = readJson('migration/baselines.json');

function canonicalize(input) {
  let current = input;
  const seen = new Set([current]);
  for (const move of repairs.moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) {
      current = `${move.to}${current.slice(move.from.length)}`;
      if (seen.has(current)) fail(`path-repair cycle while canonicalizing ${input}: ${current}`);
      seen.add(current);
    }
  }
  return current;
}

function validateSchema() {
  const require = createRequire(import.meta.url);
  let Ajv2020;
  let addFormats;
  try {
    Ajv2020 = require('ajv/dist/2020').default;
    addFormats = require('ajv-formats').default;
  } catch (error) {
    fail(`schema validator dependencies unavailable; run npm ci --ignore-scripts first (${error.message})`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const common = readJson('migration/schemas/contract-common.schema.json');
  ajv.addSchema(common, common.$id);
  const validate = ajv.compile(readJson('migration/schemas/source-aliases.schema.json'));
  if (!validate(contract)) fail(`schema: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
}

validateSchema();
const classificationSha = sha256('migration/package-classification.json');
if (contract.packageClassificationSha256 !== classificationSha) fail(`classification digest mismatch: ${contract.packageClassificationSha256} != ${classificationSha}`);

const records = classification.manifests.map((record) => ({ ...record, currentPath: canonicalize(record.path) }));
const publishedByName = new Map();
for (const record of records.filter((candidate) => candidate.published)) {
  const manifest = readJson(record.currentPath);
  if (publishedByName.has(manifest.name)) fail(`duplicate published package name: ${manifest.name}`);
  publishedByName.set(manifest.name, { ...record, manifest });
}

const unitSources = new Set(baselines.entries
  .filter((entry) => entry.lane === 'unit' && entry.id.includes('.root.'))
  .map((entry) => entry.source));
const sourceToPackage = (source) => `@uirouter/${source}`;
const unitPackages = new Set([...unitSources].map(sourceToPackage));
if (!unitPackages.has('@uirouter/core')) fail('B03 Core unit control is missing');

const sourceDirectories = ['src', 'test', 'test-zoneless', 'core', 'react'];
const sourceExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
function sourceFiles(packageRoot) {
  const output = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'lib', 'lib-esm', '_bundles', 'coverage', 'examples'].includes(entry.name)) continue;
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (sourceExtensions.has(path.extname(entry.name))) output.push(child);
    }
  };
  for (const name of sourceDirectories) {
    const directory = path.join(packageRoot, name);
    if (existsSync(directory) && statSync(directory).isDirectory()) walk(directory);
  }
  return [...new Set(output)].sort();
}

function importedSpecifiers(packageRoot) {
  const specifiers = new Set();
  const quotedInternal = /["'](@uirouter\/[a-z0-9-]+(?:\/[^"']+)*)["']/gi;
  for (const file of sourceFiles(packageRoot)) {
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const match of text.matchAll(quotedInternal)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

function packageAndExport(specifier) {
  const parts = specifier.split('/');
  const packageName = parts.slice(0, 2).join('/');
  return { packageName, exportName: parts.length === 2 ? '.' : `./${parts.slice(2).join('/')}` };
}

function resolveSourceEntrypoint(packageName, exportName) {
  const dependency = publishedByName.get(packageName);
  if (!dependency) fail(`source dependency is not a published package: ${packageName}`);
  const packageRoot = path.dirname(dependency.currentPath);
  const base = exportName === '.' ? 'src/index' : `src/${exportName.replace(/^\.\/lib\//, '')}`;
  const candidates = ['.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js'].map((suffix) => `${packageRoot}/${base}${suffix}`);
  const matches = candidates.filter((candidate) => existsSync(path.join(root, candidate)));
  if (matches.length === 0) fail(`no source entrypoint for ${packageName} ${exportName}; tried ${candidates.join(',')}`);
  return matches[0];
}

const derived = [];
for (const packageName of [...unitPackages].sort()) {
  const consumer = publishedByName.get(packageName);
  if (!consumer) fail(`B03 unit package not classified as published: ${packageName}`);
  const manifestPath = consumer.currentPath;
  const packageRoot = path.join(root, path.dirname(manifestPath));
  const imports = importedSpecifiers(packageRoot);
  for (const specifier of imports) {
    const { packageName: dependencyName, exportName } = packageAndExport(specifier);
    if (dependencyName === packageName || !publishedByName.has(dependencyName)) continue;
    const classified = classification.edges.some((edge) => canonicalize(edge.consumerManifest) === manifestPath && edge.package === dependencyName && edge.resolutionMode === 'workspace');
    if (!classified) fail(`unclassified source import: ${manifestPath} -> ${specifier}`);
    derived.push({ consumer: manifestPath, package: dependencyName, export: exportName, sourceEntrypoint: resolveSourceEntrypoint(dependencyName, exportName) });
  }
}
derived.sort((left, right) => `${left.consumer}|${left.package}|${left.export}`.localeCompare(`${right.consumer}|${right.package}|${right.export}`));

const semanticKey = (edge) => `${edge.consumer}|${edge.package}|${edge.export}`;
const ids = new Set();
const keys = new Set();
for (const edge of contract.edges) {
  if (ids.has(edge.id)) fail(`duplicate edge id: ${edge.id}`);
  ids.add(edge.id);
  const key = semanticKey(edge);
  if (keys.has(key)) fail(`duplicate semantic edge: ${key}`);
  keys.add(key);
  if (edge.evidence.path !== 'migration/package-classification.json' || edge.evidence.sha256 !== classificationSha) fail(`${edge.id} evidence does not bind the classification`);
  if (!existsSync(path.join(root, edge.consumer))) fail(`${edge.id} consumer missing: ${edge.consumer}`);
  if (!existsSync(path.join(root, edge.sourceEntrypoint))) fail(`${edge.id} source entrypoint missing: ${edge.sourceEntrypoint}`);
  if (edge.expectedRealpath !== edge.sourceEntrypoint) fail(`${edge.id} expected realpath must equal its exact source entrypoint`);
  if (edge.owner !== `source-test:${edge.consumer}`) fail(`${edge.id} owner mismatch: ${edge.owner}`);
  if (edge.lane !== 'unit-test') fail(`${edge.id} lane must be unit-test`);
  const expectedRoot = edge.sourceEntrypoint.split('/src/')[0] + '/src';
  if (JSON.stringify(edge.watchRoots) !== JSON.stringify([expectedRoot])) fail(`${edge.id} watch roots must be exactly ${expectedRoot}`);
  const activeEntries = Object.entries(edge.adapters).filter(([, adapter]) => adapter !== 'not-applicable');
  const active = activeEntries.map(([name]) => name).sort();
  const consumerName = readJson(edge.consumer).name;
  const expectedActive = consumerName === '@uirouter/angularjs' ? ['jest', 'typescript'] : ['vitest'];
  if (JSON.stringify(active) !== JSON.stringify(expectedActive)) fail(`${edge.id} adapter ownership expected ${expectedActive}, got ${active}`);
  const expectedPositive = ['node', 'tools/verify-source-aliases.mjs', '--edge', edge.id];
  const expectedWatch = ['node', 'tools/prove-source-watch.mjs', '--edge', edge.id];
  const expectedProduction = ['node', 'tools/verify-source-aliases.mjs', '--edge', edge.id, '--production'];
  if (JSON.stringify(edge.invalidationCommand.argv) !== JSON.stringify(expectedWatch)) fail(`${edge.id} invalidation command must target its exact edge`);
  for (const [name, adapter] of activeEntries) {
    if (JSON.stringify(adapter.positiveTest.argv) !== JSON.stringify(expectedPositive)) fail(`${edge.id} ${name} positive test must target its exact edge`);
    if (JSON.stringify(adapter.watchTest.argv) !== JSON.stringify(expectedWatch)) fail(`${edge.id} ${name} watch test must target its exact edge`);
    if (JSON.stringify(adapter.negativeProductionTest.argv) !== JSON.stringify(expectedProduction)) fail(`${edge.id} ${name} production test must target its exact edge`);
  }
  const sourceRoot = edge.sourceEntrypoint.split('/src/')[0];
  const expectedIgnored = ['lib', 'lib-esm', 'dist', '_bundles'].map((directory) => `${sourceRoot}/${directory}`);
  if (JSON.stringify(edge.ignoredPaths) !== JSON.stringify(expectedIgnored)) fail(`${edge.id} ignored paths must enumerate only generated outputs for ${sourceRoot}`);
  if (edge.export === '.' && edge.precedence !== 100) fail(`${edge.id} root precedence must be 100`);
  if (edge.export !== '.' && edge.precedence >= 100) fail(`${edge.id} subpath precedence must be less than root precedence`);
}

const expectedDerived = derived.map((edge) => ({ ...edge }));
const actualDerived = contract.edges.map(({ consumer, package: packageName, export: exportName, sourceEntrypoint }) => ({ consumer, package: packageName, export: exportName, sourceEntrypoint }))
  .sort((left, right) => semanticKey(left).localeCompare(semanticKey(right)));
if (JSON.stringify(actualDerived) !== JSON.stringify(expectedDerived)) {
  fail(`contract differs from independently derived imports\nexpected=${JSON.stringify(expectedDerived)}\nactual=${JSON.stringify(actualDerived)}`);
}
if (contract.edges.some((edge) => edge.consumer === publishedByName.get('@uirouter/core').currentPath)) fail('Core passing no-edge unit control unexpectedly owns a source alias');

if (selectedEdge && !ids.has(selectedEdge)) fail(`unknown --edge: ${selectedEdge}`);
if (contractOnly) {
  console.log(`SOURCE_ALIAS_CONTRACT_OK edges=${contract.edges.length} consumers=${new Set(contract.edges.map((edge) => edge.consumer)).size} noEdgeControls=1`);
  process.exit(0);
}

const helperPath = path.join(root, 'tools/source-aliases.cjs');
if (!existsSync(helperPath)) fail('shared helper missing: tools/source-aliases.cjs');
const require = createRequire(import.meta.url);
delete require.cache[helperPath];
const helper = require(helperPath);
const edgesToCheck = selectedEdge ? contract.edges.filter((edge) => edge.id === selectedEdge) : contract.edges;
for (const edge of edgesToCheck) {
  const resolved = helper.resolveSpecifierForConsumer(edge.consumer, `${edge.package}${edge.export === '.' ? '' : edge.export.slice(1)}`);
  const expected = realpathSync(path.join(root, edge.expectedRealpath));
  if (realpathSync(resolved) !== expected) fail(`${edge.id} resolves to ${resolved}, expected ${expected}`);
  for (const [name, adapter] of Object.entries(edge.adapters).filter(([, candidate]) => candidate !== 'not-applicable')) {
    if (name === 'typescript') {
      const config = readJson(adapter.configPath);
      const sortedPaths = (value) => Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
      const expectedPaths = sortedPaths(helper.typescriptPathsFor(readJson(edge.consumer).name));
      if (JSON.stringify(sortedPaths(config.compilerOptions?.paths)) !== JSON.stringify(expectedPaths)) fail(`${edge.id} TypeScript paths are not generated from the shared contract: ${adapter.configPath}`);
    } else {
      const config = readText(adapter.configPath);
      if (!config.includes('source-aliases')) fail(`${edge.id} active config does not load the shared helper: ${adapter.configPath}`);
    }
  }
}

const consumerNames = new Map(contract.edges.map((edge) => [edge.consumer, readJson(edge.consumer).name]));
for (const [consumer, packageName] of consumerNames) {
  const packageJson = readJson(consumer);
  const watchScripts = Object.entries(packageJson.scripts ?? {}).filter(([name, command]) => name.includes('watch') && /(?:vitest|jest)/.test(command));
  if (watchScripts.length === 0) fail(`${packageName} has no executable test watch script`);
  for (const [name, command] of watchScripts) {
    if (/vitest/.test(command) && !/(?:^|\s)--watch(?:\s|$)/.test(command)) fail(`${packageName} ${name} must invoke vitest with explicit --watch`);
    if (/jest/.test(command) && !/(?:^|\s)--watchAll(?:\s|$)/.test(command)) fail(`${packageName} ${name} must invoke jest with explicit --watchAll`);
  }
}

const vitestAdapters = new Map();
for (const edge of contract.edges) {
  if (edge.adapters.vitest !== 'not-applicable') vitestAdapters.set(edge.consumer, edge.adapters.vitest.configPath);
}
for (const [consumer, configPath] of vitestAdapters) {
  const packageName = readJson(consumer).name;
  const config = readText(configPath);
  if (!/source\.(?:plugins|typescriptPlugin)/.test(config)) fail(`${packageName} Vitest config does not install the shared TypeScript source compiler: ${configPath}`);
  if (!/source\.(?:plugins|watchPlugin)/.test(config)) fail(`${packageName} Vitest config does not install the shared watch plugin: ${configPath}`);

  const source = helper.vitestConfigFor(packageName);
  if (source.typescriptPlugin?.enforce !== 'pre') fail(`${packageName} shared TypeScript source compiler must run pre-transform`);
  if (!source.plugins?.includes(source.typescriptPlugin) || !source.plugins?.includes(source.watchPlugin)) fail(`${packageName} shared Vitest plugin set is incomplete`);
  const watchRoot = source.watchRoots[0];
  const probe = 'export class SourceProbe { value = this.input; constructor(private input: number) {} method() { return this.value; } }';
  const transformed = source.typescriptPlugin.transform(probe, path.join(watchRoot, '__source_alias_probe.ts'));
  if (!transformed || !/SourceProbe\.prototype\.method\s*=/.test(transformed.code)) fail(`${packageName} shared TypeScript source compiler does not preserve legacy enumerable class methods`);
  const parameterAssignment = transformed.code.indexOf('this.input = input');
  const fieldAssignment = transformed.code.indexOf('this.value = this.input');
  if (parameterAssignment === -1 || fieldAssignment === -1 || parameterAssignment > fieldAssignment) fail(`${packageName} shared TypeScript source compiler does not preserve parameter-property initialization order`);
}

const angularjsManifest = publishedByName.get('@uirouter/angularjs').currentPath;
if (readJson(angularjsManifest).scripts?.typecheck !== 'tsc -p tsconfig.source.json') fail('AngularJS typecheck must use the shared source-alias TypeScript config');
const angularjsJest = readText('frameworks/angularjs/uirouter-angularjs/jest.config.js');
if (!angularjsJest.includes('isolatedModules: true') || !angularjsJest.includes('diagnostics: false')) fail('AngularJS Jest must transpile source-linked tests while the separate typecheck lane owns diagnostics');

const productionPatterns = [
  /(?:^|\/)rollup\.config\.(?:js|cjs|mjs|ts)$/,
  /(?:^|\/)rolldown\.config\.(?:js|cjs|mjs|ts)$/,
  /(?:^|\/)vite\.config\.(?:js|cjs|mjs|ts)$/,
  /(?:^|\/)webpack\.config\.(?:js|cjs|mjs|ts)$/,
  /(?:^|\/)tsdown\.config\.(?:js|cjs|mjs|ts)$/,
  /(?:^|\/)ng-package\.json$/,
  /(?:^|\/)angular\.json$/,
];
const productionFiles = [];
const walkProduction = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'archive', 'migration', 'coverage', 'dist', 'lib', 'lib-esm', '_bundles'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkProduction(absolute);
    else {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (productionPatterns.some((pattern) => pattern.test(relative))) productionFiles.push(relative);
    }
  }
};
walkProduction(root);
for (const relative of productionFiles) {
  const text = readText(relative);
  if (text.includes('source-aliases.cjs') || text.includes('migration/source-aliases.json')) fail(`production config loads source aliases: ${relative}`);
}
if (productionOnly) {
  console.log(`SOURCE_ALIAS_PRODUCTION_OK edges=${edgesToCheck.length} configs=${productionFiles.length}`);
  process.exit(0);
}

console.log(`SOURCE_ALIASES_VERIFY_OK edges=${contract.edges.length} consumers=${new Set(contract.edges.map((edge) => edge.consumer)).size} vitest=6 jest=1 typescript=1 productionConfigs=${productionFiles.length}`);
