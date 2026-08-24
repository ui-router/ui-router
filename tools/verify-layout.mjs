#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = realpathSync(path.resolve(import.meta.dirname, '..'));
const fail = (message) => { throw new Error(message); };
const rel = (value) => path.relative(root, value).split(path.sep).join('/');
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const classification = readJson('migration/package-classification.json');
const pathRepairs = readJson('migration/path-repairs.json');
const rootManifest = readJson('package.json');
const rootLock = readJson('package-lock.json');

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

function validateMoves() {
  const ids = new Set();
  for (const move of pathRepairs.moves) {
    if (ids.has(move.id)) fail(`duplicate path-repair move id: ${move.id}`);
    ids.add(move.id);
    if (move.from === move.to || move.to.startsWith(`${move.from}/`)) {
      fail(`cyclic/self-containing path-repair move: ${move.id}`);
    }
  }
  const examples = new Map();
  for (const manifest of classification.manifests) {
    const canonical = canonicalize(manifest.path);
    const prior = examples.get(canonical);
    if (prior) fail(`classification paths collapse to ${canonical}: ${prior}, ${manifest.path}`);
    examples.set(canonical, manifest.path);
  }
}

function walkFiles(directory, output = []) {
  const skipped = new Set(['.git', 'node_modules', '.turbo', '.cache', 'coverage', 'dist']);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`symbolic links are forbidden in the package/lock inventory: ${rel(absolute)}`);
    if (entry.isDirectory()) walkFiles(absolute, output);
    else output.push(rel(absolute));
  }
  return output;
}

function inferRole(manifestPath) {
  const dir = path.posix.dirname(manifestPath);
  if (dir.includes('/examples/')) return 'example';
  if (dir.includes('/integration-tests/')) return 'integration';
  if (dir === 'tools/publish-scripts/actions/upgrade' || dir === 'tools/publish-scripts/docgen') return 'nested-tool';
  if (dir === 'core' || /^plugins\/[^/]+$/.test(dir) || /^frameworks\/[^/]+\/uirouter-[^/]+$/.test(dir) || dir === 'tools/publish-scripts') {
    return 'published-package';
  }
  fail(`cannot infer package role from canonical path: ${manifestPath}`);
}

function queryNpmWorkspaces() {
  let parsed;
  try {
    parsed = JSON.parse(execFileSync('npm', ['query', '--workspaces', '--json', ':root > *'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    fail(`npm workspace query failed: ${error.stderr?.toString().trim() || error.message}`);
  }
  if (!Array.isArray(parsed)) fail('npm workspace query did not return an array');
  if (parsed.length > 0) {
    const locations = parsed.map((item, index) => {
      if (!item || typeof item.location !== 'string') fail(`npm workspace query item ${index} has no location`);
      const absolute = path.resolve(root, item.location);
      if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) fail(`npm workspace location escapes repository: ${item.location}`);
      return rel(absolute);
    });
    if (new Set(locations).size !== locations.length) fail(`npm workspace query returned duplicate locations: ${locations.join(', ')}`);
    return { locations: locations.sort(), names: null, mode: 'installed-query' };
  }
  if (existsSync(path.join(root, 'node_modules'))) fail('installed npm workspace query unexpectedly returned no workspaces');
  try {
    const values = JSON.parse(execFileSync('npm', ['pkg', 'get', 'name', '--workspaces', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    if (!values || Array.isArray(values) || typeof values !== 'object') fail('npm workspace manifest query did not return an object');
    const names = Object.keys(values).sort();
    for (const [key, value] of Object.entries(values)) if (key !== value) fail(`npm workspace manifest query identity mismatch: ${key} -> ${value}`);
    return { locations: null, names, mode: 'manifest-query' };
  } catch (error) {
    fail(`npm workspace manifest query failed: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function main() {
  validateMoves();
  if (classification.inventoryManifestCount !== 44 || classification.manifests.length !== 44) {
    fail(`classification must contain exactly 44 imported manifests; got inventory=${classification.inventoryManifestCount}, records=${classification.manifests.length}`);
  }
  const files = walkFiles(root);
  const discovered = files.filter((file) => path.posix.basename(file) === 'package.json').sort();
  if (discovered.length !== 45) fail(`expected 45 current manifests (44 imported plus root), found ${discovered.length}`);
  const importedDiscovered = discovered.filter((file) => file !== 'package.json');
  const canonicalRecords = new Map();
  const names = new Map([[rootManifest.name, 'package.json']]);
  const realpaths = new Map();
  const expectedWorkspaces = [];
  const expectedLocks = new Set(['package-lock.json']);

  for (const record of classification.manifests) {
    const canonicalPath = canonicalize(record.path);
    if (canonicalRecords.has(canonicalPath)) fail(`duplicate canonical classified manifest: ${canonicalPath}`);
    canonicalRecords.set(canonicalPath, record);
    const absolute = path.join(root, canonicalPath);
    let physical;
    try { physical = realpathSync(absolute); } catch { fail(`classified manifest is missing: ${record.path} -> ${canonicalPath}`); }
    if (rel(physical).startsWith('../')) fail(`classified manifest resolves outside repository: ${canonicalPath}`);
    const priorPhysical = realpaths.get(physical);
    if (priorPhysical) fail(`duplicate manifest realpath: ${priorPhysical}, ${canonicalPath}`);
    realpaths.set(physical, canonicalPath);
    const manifest = JSON.parse(readFileSync(absolute, 'utf8'));
    if (manifest.name !== record.finalName) fail(`${canonicalPath}: name ${JSON.stringify(manifest.name)} != classified ${JSON.stringify(record.finalName)}`);
    const priorName = names.get(manifest.name);
    if (priorName) fail(`duplicate package name ${manifest.name}: ${priorName}, ${canonicalPath}`);
    names.set(manifest.name, canonicalPath);
    if (record.published) {
      if (record.class !== 'published-package' || manifest.private === true || record.private !== false) fail(`${canonicalPath}: published package/private classification mismatch`);
    } else if (manifest.private !== true || record.private !== true) {
      fail(`${canonicalPath}: non-published package must be private in manifest and classification`);
    }
    const actualRole = inferRole(canonicalPath);
    if (record.class !== actualRole) fail(`${canonicalPath}: classified role ${record.class} != inferred role ${actualRole}`);
    if (record.origin !== 'imported') fail(`${canonicalPath}: imported manifest has unexpected origin ${record.origin}`);
    if (!record.owningLane || !Array.isArray(record.ownedFiles) || !record.ownedFiles.includes(record.path)) fail(`${canonicalPath}: invalid lane/ownedFiles classification`);
    const shouldWorkspace = actualRole === 'published-package' || actualRole === 'example';
    if (record.workspace !== shouldWorkspace) fail(`${canonicalPath}: workspace=${record.workspace} contradicts role ${actualRole}`);
    const isBlueprint = /\/(?:scaffold|template)\/package\.json$/.test(canonicalPath);
    const expectedLockOwner = shouldWorkspace ? 'root' : actualRole === 'integration' && !isBlueprint ? 'local' : 'none';
    if (record.lockOwner !== expectedLockOwner) fail(`${canonicalPath}: lockOwner=${record.lockOwner} contradicts role ${actualRole}${isBlueprint ? ' blueprint' : ''}`);
    const dir = path.posix.dirname(canonicalPath);
    if (record.workspace) expectedWorkspaces.push(dir);
    if (record.lockOwner === 'local') expectedLocks.add(`${dir}/package-lock.json`);
  }

  const expectedManifestPaths = [...canonicalRecords.keys()].sort();
  if (JSON.stringify(importedDiscovered) !== JSON.stringify(expectedManifestPaths)) {
    const missing = expectedManifestPaths.filter((item) => !importedDiscovered.includes(item));
    const extra = importedDiscovered.filter((item) => !canonicalRecords.has(item));
    fail(`manifest inventory mismatch; missing=[${missing}], extra=[${extra}]`);
  }
  if (rootManifest.private !== true || rootManifest.name !== '@uirouter/monorepo') fail('generated root manifest identity/private policy is invalid');

  expectedWorkspaces.sort();
  const lockFiles = files.filter((file) => ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].includes(path.posix.basename(file))).sort();
  const forbidden = lockFiles.filter((file) => file.endsWith('yarn.lock') || file.endsWith('pnpm-lock.yaml'));
  if (forbidden.length) fail(`forbidden current Yarn/pnpm locks: ${forbidden.join(', ')}`);
  const npmLocks = lockFiles.filter((file) => file.endsWith('package-lock.json'));
  const expectedLockList = [...expectedLocks].sort();
  if (JSON.stringify(npmLocks) !== JSON.stringify(expectedLockList)) {
    const missing = expectedLockList.filter((item) => !npmLocks.includes(item));
    const extra = npmLocks.filter((item) => !expectedLocks.has(item));
    fail(`npm lock placement mismatch; missing=[${missing}] extra=[${extra}]`);
  }

  if (rootLock.lockfileVersion !== 3) fail(`root lockfileVersion must be 3, got ${rootLock.lockfileVersion}`);
  if (JSON.stringify(rootLock.packages?.['']?.workspaces) !== JSON.stringify(rootManifest.workspaces)) fail('root lock workspace declarations differ from root package.json');
  for (const workspacePath of expectedWorkspaces) {
    if (!rootLock.packages?.[workspacePath]) fail(`root lock has no workspace package entry: ${workspacePath}`);
    const manifest = readJson(`${workspacePath}/package.json`);
    const link = rootLock.packages?.[`node_modules/${manifest.name}`];
    if (!link || link.link !== true || canonicalize(link.resolved) !== workspacePath) fail(`root lock workspace link is invalid for ${manifest.name}: ${JSON.stringify(link)}`);
    if (/(^|\/)framework(\/|$)|\/router(\/|$)|\/integration(\/|$)/.test(link.resolved)) fail(`root lock contains stale pre-H03R link for ${manifest.name}: ${link.resolved}`);
    if (expectedLocks.has(`${workspacePath}/package-lock.json`)) fail(`workspace unexpectedly owns nested lock: ${workspacePath}`);
  }

  const npmWorkspaces = queryNpmWorkspaces();
  if (npmWorkspaces.locations) {
    if (npmWorkspaces.locations.length !== 26 || JSON.stringify(npmWorkspaces.locations) !== JSON.stringify(expectedWorkspaces)) {
      const missing = expectedWorkspaces.filter((item) => !npmWorkspaces.locations.includes(item));
      const extra = npmWorkspaces.locations.filter((item) => !expectedWorkspaces.includes(item));
      fail(`npm workspace set mismatch; expected=26 actual=${npmWorkspaces.locations.length} missing=[${missing}] extra=[${extra}]`);
    }
  } else {
    const expectedNames = expectedWorkspaces.map((workspacePath) => readJson(`${workspacePath}/package.json`).name).sort();
    if (npmWorkspaces.names.length !== 26 || JSON.stringify(npmWorkspaces.names) !== JSON.stringify(expectedNames)) {
      const missing = expectedNames.filter((item) => !npmWorkspaces.names.includes(item));
      const extra = npmWorkspaces.names.filter((item) => !expectedNames.includes(item));
      fail(`npm workspace set mismatch; expected=26 actual=${npmWorkspaces.names.length} missingNames=[${missing}] extraNames=[${extra}]`);
    }
  }

  console.log(`LAYOUT_VERIFY_OK imported=44 workspaces=${expectedWorkspaces.length} localLocks=${expectedLocks.size - 1} npmMode=${npmWorkspaces.mode}`);
}

try { main(); } catch (error) { console.error(`LAYOUT_VERIFY_FAILED: ${error.message}`); process.exitCode = 1; }
