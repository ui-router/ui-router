#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repository = realpathSync(path.resolve(import.meta.dirname, '..'));
const fail = (message) => { throw new Error(message); };
const readJsonAt = (base, file) => JSON.parse(readFileSync(path.join(base, file), 'utf8'));
const classification = readJsonAt(repository, 'migration/package-classification.json');
const pathRepairs = readJsonAt(repository, 'migration/path-repairs.json');
const sources = readJsonAt(repository, 'migration/sources.json');
const sourceInventory = readJsonAt(repository, 'migration/evidence/control/n00/inventory.json');
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function canonicalize(input) {
  let current = input;
  const seen = new Set([current]);
  for (const move of pathRepairs.moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) {
      current = `${move.to}${current.slice(move.from.length)}`;
      if (seen.has(current)) fail(`path-repair cycle while canonicalizing ${input}: ${current}`);
      seen.add(current);
    }
  }
  return current;
}

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const edgeId = (originalManifest, section, packageName) =>
  `edge-${slug(originalManifest.replace(/\/package\.json$/, ''))}-${slug(section)}-${slug(packageName)}`;
const legacyId = (originalManifest, packageName, key) =>
  `edge-${slug(originalManifest.replace(/\/package\.json$/, ''))}-legacy-injected-${slug(packageName)}-${slug(key)}`;

function packageUniverse() {
  const byName = new Map();
  const byCanonicalPath = new Map();
  for (const record of classification.manifests) {
    const canonicalPath = canonicalize(record.path);
    const manifest = readJsonAt(repository, canonicalPath);
    if (byName.has(manifest.name)) fail(`duplicate internal package name: ${manifest.name}`);
    if (manifest.name !== record.finalName) fail(`${canonicalPath}: name differs from classification`);
    const item = { record, canonicalPath, directory: path.posix.dirname(canonicalPath), manifest };
    byName.set(manifest.name, item);
    byCanonicalPath.set(canonicalPath, item);
  }
  return { byName, byCanonicalPath };
}

function sourceDeclaredSpecs(universe) {
  const result = new Map();
  for (const source of sourceInventory.sources) {
    for (const snapshot of source.manifests) {
      const canonicalPath = canonicalize(snapshot.finalPath);
      if (!universe.byCanonicalPath.has(canonicalPath)) fail(`source inventory manifest is not classified: ${snapshot.finalPath} -> ${canonicalPath}`);
      for (const section of sections) {
        for (const [packageName, spec] of Object.entries(snapshot.dependencies?.[section] || {})) {
          if (universe.byName.has(packageName)) result.set(`${snapshot.finalPath}\0${section}\0${packageName}`, spec);
        }
      }
    }
  }
  return result;
}

function satisfies(version, range) {
  const parse = (value) => {
    const match = String(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) fail(`unsupported semantic version: ${value}`);
    return match.slice(1).map(Number);
  };
  const compare = (a, b) => {
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  };
  const actual = parse(version);
  if (range === '*' || range === 'latest') return true;
  if (range.includes('||')) return range.split('||').some((part) => satisfies(version, part.trim()));
  if (range.startsWith('^')) {
    const minimum = parse(range.slice(1));
    if (compare(actual, minimum) < 0) return false;
    const maximum = minimum[0] > 0 ? [minimum[0] + 1, 0, 0] : minimum[1] > 0 ? [0, minimum[1] + 1, 0] : [0, 0, minimum[2] + 1];
    return compare(actual, maximum) < 0;
  }
  if (range.startsWith('>=')) return compare(actual, parse(range.slice(2))) >= 0;
  return compare(actual, parse(range)) === 0;
}

function expectedOriginFor(target, mode) {
  if (mode === 'workspace') return `workspace:${target.record.path}`;
  if (mode === 'local-tarball') return `packed-artifact:${target.manifest.name}@${target.manifest.version}`;
  return `published-registry:${target.manifest.name}@${target.manifest.version}`;
}

function validateEdgeContract(edge, consumer, target, actualSpec, sourceSpec) {
  if (edge.owningLane !== consumer.record.owningLane) fail(`${edge.id}: owningLane differs from consumer classification`);
  if (edge.expectedVersion !== target.manifest.version) fail(`${edge.id}: expectedVersion ${edge.expectedVersion} != target ${target.manifest.version}`);
  const expectedOrigin = expectedOriginFor(target, edge.resolutionMode);
  if (edge.expectedOrigin !== expectedOrigin) fail(`${edge.id}: expectedOrigin ${edge.expectedOrigin} != independently derived ${expectedOrigin}`);
  if (edge.declaredSpec !== sourceSpec) fail(`${edge.id}: declaredSpec ${JSON.stringify(edge.declaredSpec)} != source snapshot ${JSON.stringify(sourceSpec)}`);
  if (edge.resolutionMode === 'workspace') {
    if (!target.record.workspace || target.record.lockOwner !== 'root') fail(`${edge.id}: workspace target is not a classified root workspace`);
    if (actualSpec !== null) {
      if (actualSpec !== edge.finalSpec) fail(`${edge.id}: current spec ${actualSpec} != finalSpec ${edge.finalSpec}`);
      if (/^(?:file:|workspace:)/.test(actualSpec)) fail(`${edge.id}: workspace edge uses forbidden publish-unsafe spec ${actualSpec}`);
      if (!satisfies(target.manifest.version, actualSpec)) fail(`${edge.id}: target ${target.manifest.version} does not satisfy ${actualSpec}`);
    } else if (!satisfies(target.manifest.version, edge.finalSpec)) {
      fail(`${edge.id}: legacy target ${target.manifest.version} does not satisfy classified ${edge.finalSpec}`);
    }
    if (edge.packedExpectation !== 'local-tarball') fail(`${edge.id}: workspace edge packedExpectation must be local-tarball`);
  } else if (edge.resolutionMode === 'local-tarball') {
    if (!['integration', 'fixture'].includes(consumer.record.class)) fail(`${edge.id}: local-tarball consumer is not integration/fixture`);
    if (actualSpec !== null) {
      if (actualSpec !== sourceSpec) fail(`${edge.id}: committed local manifest must retain source spec ${sourceSpec}, got ${actualSpec}`);
      if (actualSpec.startsWith('workspace:') || actualSpec.startsWith('file:')) fail(`${edge.id}: committed local baseline uses ${actualSpec}`);
    }
    if (edge.finalSpec !== `artifact:${target.manifest.name}@${target.manifest.version}`) fail(`${edge.id}: invalid artifact token ${edge.finalSpec}`);
    if (edge.packedExpectation !== 'local-tarball') fail(`${edge.id}: local-tarball packedExpectation mismatch`);
  } else {
    fail(`${edge.id}: unexpected published-registry internal edge`);
  }
}

function deriveDeclared(universe, sourceSpecs, classifiedById) {
  const derived = new Map();
  for (const consumer of universe.byCanonicalPath.values()) {
    for (const section of sections) {
      for (const [packageName, actualSpec] of Object.entries(consumer.manifest[section] || {})) {
        const target = universe.byName.get(packageName);
        if (!target) continue;
        const id = edgeId(consumer.record.path, section, packageName);
        if (derived.has(id)) fail(`duplicate derived current edge: ${id}`);
        const edge = classifiedById.get(id);
        if (!edge) fail(`unclassified current internal edge: ${id}`);
        if (edge.manifestSection !== section || edge.consumerManifest !== consumer.record.path || edge.package !== packageName) fail(`${id}: classification identity mismatch`);
        if (edge.declaredSpec === null || edge.manifestSection === 'legacy-injected') fail(`${id}: current edge is classified only as legacy`);
        const sourceSpec = sourceSpecs.get(`${consumer.record.path}\0${section}\0${packageName}`);
        if (sourceSpec === undefined) fail(`${id}: no independent N00 source declaration`);
        validateEdgeContract(edge, consumer, target, actualSpec, sourceSpec);
        derived.set(id, { edge, consumer, target });
      }
    }
  }
  return derived;
}

function sourceDestinationMap() {
  const result = new Map();
  for (const source of sources.sources) {
    const url = source.url.replace(/\/$/, '');
    const repositoryName = new URL(url).pathname.split('/').pop().replace(/\.git$/, '');
    // Re-derive N00's remote identity rule: a downstream repository basename maps to
    // an imported source name. The angular-ui/ui-router alias intentionally does not
    // become "angularjs" here; source-alias normalization belongs to S02.
    if (repositoryName === source.name) result.set(url, canonicalize(source.destinationPrefix));
  }
  return result;
}

function downstreamEntries(value, prefix = [], rootLevel = true) {
  const result = [];
  for (const [key, item] of Object.entries(value)) {
    if (key === 'packageDir') continue;
    if (key === 'projects' && item && typeof item === 'object' && !Array.isArray(item)) {
      result.push(...downstreamEntries(item, [], true));
    } else if (typeof item === 'string') {
      result.push({ key: (prefix.length ? [...prefix, key] : ['default', key]).join('.'), destination: item });
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      result.push(...downstreamEntries(item, [...prefix, key], false));
    } else {
      fail(`invalid downstream configuration at ${[...prefix, key].join('.')}`);
    }
  }
  return result;
}

function deriveLegacy(universe, classifiedById) {
  const sourceMap = sourceDestinationMap();
  const downstreamFiles = [
    'core/downstream_projects.json',
    'frameworks/angular/uirouter-angular/downstream_projects.json',
    'frameworks/angular-hybrid/uirouter-angular-hybrid/downstream_projects.json',
    'frameworks/angularjs/uirouter-angularjs/downstream_projects.json',
    'frameworks/react/uirouter-react/downstream_projects.json',
    'frameworks/react-hybrid/uirouter-react-hybrid/downstream_projects.json',
    'plugins/dsr/downstream_projects.json',
    'plugins/sticky-states/downstream_projects.json',
  ];
  const derived = new Map();
  for (const configPath of downstreamFiles) {
    const producerDirectory = path.posix.dirname(configPath);
    const producerPath = `${producerDirectory}/package.json`;
    const producer = universe.byCanonicalPath.get(producerPath);
    if (!producer) fail(`downstream producer is not classified: ${producerPath}`);
    for (const entry of downstreamEntries(readJsonAt(repository, configPath))) {
      let consumerDirectory;
      if (/^https?:\/\//.test(entry.destination)) {
        consumerDirectory = sourceMap.get(entry.destination.replace(/\/$/, ''));
        if (!consumerDirectory) continue;
      } else {
        consumerDirectory = path.posix.normalize(path.posix.join(producerDirectory, entry.destination));
        if (consumerDirectory.startsWith('../') || path.posix.isAbsolute(consumerDirectory)) fail(`${configPath}:${entry.key}: destination escapes repository`);
      }
      const consumerPath = `${consumerDirectory}/package.json`;
      const consumer = universe.byCanonicalPath.get(consumerPath);
      if (!consumer) fail(`${configPath}:${entry.key}: downstream destination has no classified manifest: ${consumerPath}`);
      const id = legacyId(consumer.record.path, producer.manifest.name, entry.key);
      if (derived.has(id)) fail(`duplicate derived legacy identity: ${id}`);
      const edge = classifiedById.get(id);
      if (!edge) fail(`unclassified current downstream relationship: ${id}`);
      if (edge.manifestSection !== 'legacy-injected' || edge.declaredSpec !== null) fail(`${id}: derived downstream relation is not a null legacy classification`);
      if (edge.consumerManifest !== consumer.record.path || edge.package !== producer.manifest.name) fail(`${id}: producer/consumer classification mismatch`);
      if (!['integration', 'example', 'published-package'].includes(consumer.record.class)) fail(`${id}: invalid downstream consumer role ${consumer.record.class}`);
      const mode = consumer.record.internalResolutionMode;
      if (edge.resolutionMode !== mode) fail(`${id}: resolutionMode ${edge.resolutionMode} != consumer mode ${mode}`);
      validateEdgeContract(edge, consumer, producer, null, null);
      derived.set(id, { edge, consumer, target: producer });
    }
  }
  return derived;
}

function validateRootLock(workspaceEdges) {
  const lock = readJsonAt(repository, 'package-lock.json');
  if (lock.lockfileVersion !== 3) fail('root lockfileVersion must be 3');
  for (const { edge, target } of workspaceEdges.values()) {
    const item = lock.packages?.[`node_modules/${edge.package}`];
    if (!item || item.link !== true) fail(`${edge.id}: root lock does not use a workspace link`);
    if (canonicalize(item.resolved) !== target.directory) fail(`${edge.id}: root link resolves to ${item.resolved}, expected ${target.directory}`);
    if ('version' in item || /^https?:|^file:/.test(item.resolved)) fail(`${edge.id}: workspace link has registry/file fallback metadata`);
  }
}

function validateLocalLocks(localEdges) {
  const byConsumer = new Map();
  for (const value of localEdges.values()) {
    if (!byConsumer.has(value.consumer.canonicalPath)) byConsumer.set(value.consumer.canonicalPath, []);
    byConsumer.get(value.consumer.canonicalPath).push(value);
  }
  for (const [consumerPath, edges] of byConsumer) {
    const consumer = edges[0].consumer;
    const lockPath = `${consumer.directory}/package-lock.json`;
    if (consumer.record.lockOwner === 'none') {
      if (existsSync(path.join(repository, lockPath))) fail(`${consumerPath}: template blueprint unexpectedly has a lock`);
      continue;
    }
    if (consumer.record.lockOwner !== 'local') fail(`${consumerPath}: local edge consumer has lockOwner=${consumer.record.lockOwner}`);
    const lock = readJsonAt(repository, lockPath);
    if (lock.lockfileVersion !== 3) fail(`${lockPath}: lockfileVersion must be 3`);
    if (lock.packages?.['']?.name !== consumer.manifest.name || lock.packages?.['']?.version !== consumer.manifest.version) fail(`${lockPath}: root identity differs from manifest`);
    for (const { edge } of edges) {
      const item = lock.packages?.[`node_modules/${edge.package}`];
      if (!item) fail(`${edge.id}: local lock has no direct internal package entry`);
      if (item.link === true) fail(`${edge.id}: committed registry baseline is a workspace link`);
      if (item.version !== edge.expectedVersion) fail(`${edge.id}: local lock version ${item.version} != ${edge.expectedVersion}`);
      if (!/^https:\/\/registry\.npmjs\.org\//.test(item.resolved || '')) fail(`${edge.id}: local lock origin is not the registry baseline: ${item.resolved}`);
    }
  }
}

function validateResolutionPolicy(universe) {
  const rootManifest = readJsonAt(repository, 'package.json');
  if (rootManifest.overrides || rootManifest.resolutions) fail('root overrides/resolutions are forbidden');
  const exactOverride = { '@uirouter/angular': { '@angular/common': '$@angular/common', '@angular/core': '$@angular/core' } };
  const allowed = new Set([
    'frameworks/angular/integration-tests/angular-versions/v22/package.json',
    'frameworks/angular/integration-tests/angular-versions/v22-standalone/package.json',
    'frameworks/angular/integration-tests/angular-versions/v22-zoneless/package.json',
  ]);
  for (const item of universe.byCanonicalPath.values()) {
    if (item.manifest.resolutions !== undefined) fail(`${item.canonicalPath}: current Yarn resolutions are forbidden by classified resolution decisions`);
    if (item.manifest.overrides !== undefined) {
      if (!allowed.has(item.canonicalPath)) fail(`${item.canonicalPath}: unclassified package-local override`);
      if (JSON.stringify(item.manifest.overrides) !== JSON.stringify(exactOverride)) fail(`${item.canonicalPath}: Angular integration override differs from approved exact shape`);
    } else if (allowed.has(item.canonicalPath)) fail(`${item.canonicalPath}: approved isolated override is missing`);
  }
  if (classification.resolutions.length !== 7) fail(`expected 7 classified resolution decisions, found ${classification.resolutions.length}`);
}

function npmLsGraph(directory) {
  try {
    return JSON.parse(execFileSync('npm', ['ls', '--all', '--json'], { cwd: directory, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    if (!error.stdout) fail(`npm ls produced no JSON in ${directory}: ${error.stderr?.toString().trim() || error.message}`);
    try { return JSON.parse(error.stdout.toString()); } catch { fail(`npm ls produced invalid JSON in ${directory}`); }
  }
}

function assertInternalNpmLs(directory, expectedVersions) {
  const graph = npmLsGraph(directory);
  const seen = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const [name, dependency] of Object.entries(node.dependencies || {})) {
      if (expectedVersions.has(name)) {
        const badFlags = ['invalid', 'missing', 'extraneous', 'overridden'].filter((flag) => dependency?.[flag]);
        if (badFlags.length) fail(`npm ls internal problem in ${directory}: ${name} ${badFlags.join(',')}`);
        if (dependency?.version !== expectedVersions.get(name)) fail(`npm ls internal version in ${directory}: ${name}@${dependency?.version} != ${expectedVersions.get(name)}`);
      }
      visit(dependency);
    }
  }
  visit(graph);
}

function validateInstalled(installedRoot, workspaceEdges, localEdges, universe) {
  const install = realpathSync(path.resolve(installedRoot));
  if (install === repository || install.startsWith(`${repository}${path.sep}`) || repository.startsWith(`${install}${path.sep}`)) fail('--installed-root must be outside repository ancestry');
  const expectedVersions = new Map([...universe.byName].map(([name, item]) => [name, item.manifest.version]));
  assertInternalNpmLs(install, expectedVersions);
  for (const { edge, target } of workspaceEdges.values()) {
    const packagePath = path.join(install, 'node_modules', ...edge.package.split('/'));
    if (!existsSync(packagePath)) fail(`${edge.id}: installed root has no ${edge.package}`);
    const physical = realpathSync(packagePath);
    const expected = realpathSync(path.join(install, target.directory));
    if (physical !== expected) fail(`${edge.id}: workspace physical origin ${physical} != ${expected}`);
    const manifest = readJsonAt(physical, 'package.json');
    if (manifest.name !== edge.package || manifest.version !== edge.expectedVersion) fail(`${edge.id}: installed workspace identity/version mismatch`);
  }
  const checkedLocalContexts = new Set();
  for (const { edge, consumer } of localEdges.values()) {
    if (consumer.record.lockOwner === 'none') continue;
    const context = path.join(install, consumer.directory);
    if (!checkedLocalContexts.has(context)) {
      assertInternalNpmLs(context, expectedVersions);
      checkedLocalContexts.add(context);
    }
    const packagePath = path.join(context, 'node_modules', ...edge.package.split('/'));
    if (!existsSync(packagePath)) fail(`${edge.id}: installed local consumer has no ${edge.package}`);
    const physical = realpathSync(packagePath);
    const consumerRoot = realpathSync(path.join(install, consumer.directory));
    if (!physical.startsWith(`${consumerRoot}${path.sep}`)) fail(`${edge.id}: local dependency escaped consumer install: ${physical}`);
    const manifest = readJsonAt(physical, 'package.json');
    if (manifest.name !== edge.package || manifest.version !== edge.expectedVersion) fail(`${edge.id}: installed local identity/version mismatch`);
  }
}

function main() {
  if (classification.edges.length !== 137) fail(`expected 137 classified edges, found ${classification.edges.length}`);
  const classifiedById = new Map();
  const semantic = new Set();
  for (const edge of classification.edges) {
    if (classifiedById.has(edge.id)) fail(`duplicate classified edge id: ${edge.id}`);
    classifiedById.set(edge.id, edge);
    const key = `${edge.consumerManifest}\0${edge.manifestSection}\0${edge.package}\0${edge.id.includes('-legacy-injected-') ? edge.id : ''}`;
    if (semantic.has(key)) fail(`duplicate classified semantic edge: ${edge.id}`);
    semantic.add(key);
  }
  const nullEdges = classification.edges.filter((edge) => edge.declaredSpec === null);
  if (nullEdges.length !== 28 || nullEdges.some((edge) => edge.manifestSection !== 'legacy-injected')) fail('all and only 28 null declaredSpec records must be legacy-injected');
  const universe = packageUniverse();
  const sourceSpecs = sourceDeclaredSpecs(universe);
  const declared = deriveDeclared(universe, sourceSpecs, classifiedById);
  const legacy = deriveLegacy(universe, classifiedById);
  const all = new Map([...declared, ...legacy]);
  const missing = [...classifiedById.keys()].filter((id) => !all.has(id));
  const extra = [...all.keys()].filter((id) => !classifiedById.has(id));
  if (declared.size !== 109 || legacy.size !== 28 || all.size !== 137 || missing.length || extra.length) fail(`edge coverage mismatch current=${declared.size} legacy=${legacy.size} total=${all.size} missing=[${missing}] extra=[${extra}]`);
  const workspaceEdges = new Map([...all].filter(([, value]) => value.edge.resolutionMode === 'workspace'));
  const localEdges = new Map([...all].filter(([, value]) => value.edge.resolutionMode === 'local-tarball'));
  const declaredLocalEdges = new Map([...declared].filter(([, value]) => value.edge.resolutionMode === 'local-tarball'));
  validateRootLock(workspaceEdges);
  validateLocalLocks(declaredLocalEdges);
  validateResolutionPolicy(universe);
  const installedIndex = process.argv.indexOf('--installed-root');
  if (installedIndex !== -1) {
    if (!process.argv[installedIndex + 1]) fail('--installed-root requires a path');
    validateInstalled(process.argv[installedIndex + 1], workspaceEdges, declaredLocalEdges, universe);
  }
  console.log(`INTERNAL_DEPS_VERIFY_OK current=${declared.size} legacy=${legacy.size} workspace=${workspaceEdges.size} localTarball=${localEdges.size}${installedIndex === -1 ? ' installed=not-requested' : ' installed=verified'}`);
}

try { main(); } catch (error) { console.error(`INTERNAL_DEPS_VERIFY_FAILED: ${error.message}`); process.exitCode = 1; }
