import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const releaseVersionPlanPath = 'release/version-plan.json';
export const releaseVersionBaselinePath = 'release/version-baseline.json';
const classificationPath = 'migration/package-classification.json';
const repairsPath = 'migration/path-repairs.json';
const sourcesPath = 'migration/sources.json';
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => {
  throw new Error(`RELEASE_VERSION_PLAN_FAILED: ${message}`);
};
const equal = (actual, expected, label) => {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} differs from the release plan`);
};
function shape(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label}`);
  equal(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
}
function semverApi() {
  const npmCli = realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
  return createRequire(path.join(path.dirname(npmCli), '..', 'package.json'))('semver');
}
function inputs(root, baseCommit) {
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) fail('baseCommit must be a full immutable commit ID');
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    git('merge-base', '--is-ancestor', baseCommit, 'HEAD');
  } catch {
    fail('baseCommit must be available and ancestral to HEAD');
  }
  const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  const before = (file) => JSON.parse(git('show', `${baseCommit}:${file}`).toString('utf8'));
  const baselineBytes = readFileSync(path.join(root, releaseVersionBaselinePath));
  const baseline = JSON.parse(baselineBytes);
  shape(baseline, ['schemaVersion', 'sourceCommit'], 'version baseline');
  if (baseline.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(baseline.sourceCommit))
    fail('version baseline requires schemaVersion 1 and a full immutable sourceCommit');
  try {
    git('merge-base', '--is-ancestor', baseline.sourceCommit, baseCommit);
  } catch {
    fail('version baseline must be available and ancestral to baseCommit');
  }
  const bindings = { versionBaselineSha256: hash(baselineBytes) };
  for (const [field, file] of [
    ['classificationSha256', classificationPath],
    ['pathRepairsSha256', repairsPath],
    ['sourcesSha256', sourcesPath],
  ]) {
    const bytes = readFileSync(path.join(root, file));
    bindings[field] = hash(bytes);
    equal(bindings[field], hash(git('show', `${baseCommit}:${file}`)), `${file} historical binding`);
  }
  const classification = read(classificationPath);
  const repairs = read(repairsPath);
  const canonical = (file) => {
    for (const move of repairs.moves) {
      if (file === move.from || file.startsWith(`${move.from}/`)) file = move.to + file.slice(move.from.length);
    }
    if (path.posix.isAbsolute(file) || file.split('/').includes('..')) fail('manifest path escapes repository');
    return file;
  };
  const manifests = new Map(
    classification.manifests.map((record) => {
      const file = canonical(record.path);
      return [file, { record, file, before: before(file), current: read(file) }];
    }),
  );
  const byName = new Map([...manifests.values()].map((item) => [item.record.finalName, item]));
  // Some published packages have no incoming workspace edges. Check all starting
  // versions against a separately reviewed baseline, not the proposed base itself.
  for (const item of manifests.values()) {
    if (!item.record.published) continue;
    const accepted = JSON.parse(git('show', `${baseline.sourceCommit}:${item.file}`).toString('utf8'));
    equal(item.before.name, accepted.name, `${item.file} baseline name`);
    equal(item.before.version, accepted.version, `${item.file} baseline version`);
  }
  // The base is the accepted workspace graph, never a self-certifying candidate.
  // Isolated registry baselines are deliberately not projected onto new versions.
  for (const edge of classification.edges.filter((edge) => edge.resolutionMode === 'workspace')) {
    equal(byName.get(edge.package)?.before.version, edge.expectedVersion, `${edge.id} base version`);
    if (edge.declaredSpec !== null) {
      equal(
        manifests.get(canonical(edge.consumerManifest))?.before[edge.manifestSection]?.[edge.package],
        edge.finalSpec,
        `${edge.id} base range`,
      );
    }
  }
  return { read, before, bindings, classification, canonical, manifests, byName, git };
}

function releaseEligibility({ read, canonical, git }, semver) {
  const sources = read(sourcesPath).sources;
  const tags = git('tag', '--list').toString('utf8').trim().split('\n');
  const mergedTags = new Set(git('tag', '--merged', 'HEAD', '--list').toString('utf8').trim().split('\n'));
  return (item, version) => {
    const source = sources.find((source) => canonical(`${source.destinationPrefix}/package.json`) === item.file);
    if (!source?.tagNamespace || !Array.isArray(source.releaseTags))
      fail(`${item.file}: missing release history mapping`);
    // Imported release records also prevent deleting a local tag from making an
    // already published version appear available. No registry access is needed.
    const knownTags = new Set([...tags, ...source.releaseTags.map((tag) => tag.targetName)]);
    const versions = [...knownTags]
      .filter((tag) => tag.startsWith(source.tagNamespace))
      .map((tag) => ({ tag, version: semver.valid(tag.slice(source.tagNamespace.length)) }))
      .filter((tag) => tag.version);
    if (versions.some((tag) => semver.eq(tag.version, version)))
      fail(`${item.record.finalName}: release version ${version} is already tagged`);
    const previous = versions
      .filter(
        (tag) =>
          mergedTags.has(tag.tag) ||
          source.releaseTags.some((imported) => imported.targetName === tag.tag && imported.reachableFromDefault),
      )
      .sort((a, b) => semver.rcompare(a.version, b.version))[0];
    if (previous && !semver.gt(version, previous.version))
      fail(`${item.record.finalName}: release version must be newer than ${previous.tag}`);
  };
}

// A plan is reviewable input, not a claim that a maintainer approved publication.
// No proof, migration contract, manifest, or lock is rewritten by this module.
export function validateReleaseVersionPlan(root, plan) {
  shape(
    plan,
    [
      'schemaVersion',
      'baseCommit',
      'versionBaselineSha256',
      'classificationSha256',
      'pathRepairsSha256',
      'sourcesSha256',
      'packages',
      'dependencyUpdates',
    ],
    'plan',
  );
  if (
    plan.schemaVersion !== 1 ||
    !Array.isArray(plan.packages) ||
    !plan.packages.length ||
    !Array.isArray(plan.dependencyUpdates)
  )
    fail('invalid plan version or package/update lists');
  const context = inputs(root, plan.baseCommit);
  const { read, before, bindings, classification, canonical, manifests, byName } = context;
  for (const [key, value] of Object.entries(bindings)) equal(plan[key], value, key);
  const semver = semverApi();
  const checkEligibility = releaseEligibility(context, semver);
  const packages = new Map();
  const expectedManifests = new Map([...manifests].map(([file, item]) => [file, structuredClone(item.before)]));
  const lock = before('package-lock.json');
  if (lock.lockfileVersion !== 3 || !lock.packages) fail('base lock must be version 3');
  for (const item of manifests.values()) {
    if (item.record.lockOwner !== 'root') continue;
    const entry = lock.packages[path.posix.dirname(item.file)];
    if (!entry) fail(`missing base workspace lock entry: ${item.file}`);
    for (const field of ['name', 'version']) equal(entry[field], item.before[field], `${item.file} base lock ${field}`);
    for (const section of sections)
      equal(entry[section] ?? {}, item.before[section] ?? {}, `${item.file} base lock ${section}`);
  }
  for (const item of plan.packages) {
    shape(item, ['name', 'manifest', 'from', 'to'], 'package');
    const source = byName.get(item.name);
    if (!source?.record.published || source.file !== item.manifest || packages.has(item.name))
      fail(`unknown or duplicate release package: ${item.name}`);
    equal(item.from, source.before.version, `${item.name} previous version`);
    if (semver.valid(item.to) !== item.to || semver.lt(item.to, item.from))
      fail(`${item.name} requires a valid, non-decreasing version`);
    // An assigned unreleased version (for example React Hybrid 3.0.0) can be
    // selected without dependency edits; it must still pass release eligibility.
    checkEligibility(source, item.to);
    packages.set(item.name, item);
    expectedManifests.get(item.manifest).version = item.to;
    lock.packages[path.posix.dirname(item.manifest)].version = item.to;
  }
  const edges = new Map(classification.edges.map((edge) => [edge.id, edge]));
  const updates = new Map();
  for (const update of plan.dependencyUpdates) {
    shape(update, ['edgeId', 'from', 'to'], 'dependency update');
    const edge = edges.get(update.edgeId);
    if (!edge || edge.resolutionMode !== 'workspace' || edge.declaredSpec === null || updates.has(update.edgeId))
      fail(`unknown, duplicate, or non-workspace update: ${update.edgeId}`);
    const target = packages.get(edge.package);
    equal(update.from, edge.finalSpec, `${edge.id} previous range`);
    const exact = typeof update.from === 'string' ? update.from.replace(/^=/, '') : '';
    if (
      !target ||
      semver.valid(exact) !== target.from ||
      semver.major(target.from) !== semver.major(target.to) ||
      update.to !== (update.from.startsWith('=') ? `=${target.to}` : target.to) ||
      update.to === update.from
    ) {
      fail(
        `${edge.id}: only exact internal updates within the same major are allowed; review compatibility separately`,
      );
    }
    const file = canonical(edge.consumerManifest);
    const owner = manifests.get(file);
    if (owner.record.published && !packages.has(owner.record.finalName))
      fail(`${edge.id}: dependent release package is missing`);
    expectedManifests.get(file)[edge.manifestSection][edge.package] = update.to;
    lock.packages[path.posix.dirname(file)][edge.manifestSection][edge.package] = update.to;
    updates.set(edge.id, update);
  }
  const angularNames = ['@uirouter/angular', '@uirouter/angular-hybrid'];
  if (angularNames.some((name) => packages.has(name))) {
    const [angular, hybrid] = angularNames.map((name) => packages.get(name));
    if (!angular || !hybrid || angular.to !== hybrid.to)
      fail('Angular and Angular Hybrid must be planned together at the same version');
    for (const item of [angular, hybrid]) {
      if (
        !semver.satisfies(
          `${semver.major(item.to)}.0.0`,
          byName.get(item.name).before.peerDependencies?.['@angular/core'] || '',
        )
      )
        fail('Angular release major differs from its supported peer range');
    }
  }
  // Compare whole documents: preparation may change only the listed versions
  // and exact internal specs, never silently re-resolve the external lock graph.
  for (const [file, expected] of expectedManifests) equal(read(file), expected, `${file} manifest`);
  equal(read('package.json'), before('package.json'), 'root manifest');
  equal(read('package-lock.json'), lock, 'root lock');
  const currentEdges = classification.edges.map((edge) => {
    if (edge.resolutionMode !== 'workspace') return edge;
    const current = {
      ...edge,
      expectedVersion: packages.get(edge.package)?.to ?? edge.expectedVersion,
      finalSpec: updates.get(edge.id)?.to ?? edge.finalSpec,
    };
    if (!semver.validRange(current.finalSpec) || !semver.satisfies(current.expectedVersion, current.finalSpec))
      fail(`${edge.id}: release version does not satisfy ${current.finalSpec}`);
    return current;
  });
  return { ...classification, edges: currentEdges };
}

export function currentReleaseClassification(root, classification) {
  const file = path.join(root, releaseVersionPlanPath);
  if (!existsSync(file)) return classification;
  return validateReleaseVersionPlan(root, JSON.parse(readFileSync(file, 'utf8')));
}

export function releaseVersionPlanSha256(root) {
  const file = path.join(root, releaseVersionPlanPath);
  return existsSync(file) ? hash(readFileSync(file)) : undefined;
}

export function createReleaseVersionPlan(root, baseCommit, selectedPackages = []) {
  const { bindings, classification, canonical, manifests, byName } = inputs(root, baseCommit);
  if (!Array.isArray(selectedPackages) || new Set(selectedPackages).size !== selectedPackages.length)
    fail('selected packages must be a list without duplicates');
  for (const name of selectedPackages)
    if (!byName.get(name)?.record.published) fail(`unknown selected release package: ${name}`);
  const selected = new Set(selectedPackages);
  const dependencyUpdates = classification.edges
    .filter((edge) => edge.resolutionMode === 'workspace' && edge.declaredSpec !== null)
    .flatMap((edge) => {
      const to = manifests.get(canonical(edge.consumerManifest)).current[edge.manifestSection]?.[edge.package];
      return to === edge.finalSpec ? [] : [{ edgeId: edge.id, from: edge.finalSpec, to }];
    });
  const changedOwners = new Set(
    dependencyUpdates.map((update) =>
      canonical(classification.edges.find((edge) => edge.id === update.edgeId).consumerManifest),
    ),
  );
  const packages = [...manifests.values()]
    .filter(
      (item) =>
        item.record.published &&
        (selected.has(item.record.finalName) ||
          item.before.version !== item.current.version ||
          changedOwners.has(item.file)),
    )
    .map((item) => ({
      name: item.record.finalName,
      manifest: item.file,
      from: item.before.version,
      to: item.current.version,
    }));
  const plan = { schemaVersion: 1, baseCommit, ...bindings, packages, dependencyUpdates };
  validateReleaseVersionPlan(root, plan);
  return plan;
}
