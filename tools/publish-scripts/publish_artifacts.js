'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { pathToFileURL } = require('url');
const { isDeepStrictEqual } = require('util');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function localRegistry(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Rehearsal requires http://127.0.0.1:<port>/ with no credentials or path.');
  return url.origin + '/';
}
function packedManifest(file) {
  return JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { maxBuffer: 1024 * 1024 }).toString());
}
function orderedArtifacts(artifacts, selected) {
  const byName = new Map(artifacts.map((item) => [item.package, item]));
  const done = new Set(),
    visiting = new Set(),
    result = [];
  function visit(name) {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`Internal dependency cycle: ${name}`);
    const item = byName.get(name);
    if (!item) throw new Error(`Selected package is absent from staged artifacts: ${name}`);
    visiting.add(name);
    for (const dependency of Object.keys({ ...item.manifest.dependencies, ...item.manifest.peerDependencies }).sort())
      if (byName.has(dependency)) visit(dependency);
    visiting.delete(name);
    done.add(name);
    result.push(item);
  }
  visit(selected);
  return result;
}
async function readback(registry, item) {
  const response = await fetch(registry + encodeURIComponent(item.package), {
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Registry metadata failed: ${response.status} ${item.package}`);
  const metadata = await response.json();
  const version = metadata.versions?.[item.version];
  if (!version) return false;
  const url = new URL(version.dist?.tarball);
  if (url.origin !== new URL(registry).origin || url.username || url.password)
    throw new Error(`Registry tarball must stay on the loopback registry: ${item.package}`);
  const tarball = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!tarball.ok) throw new Error(`Registry tarball failed: ${tarball.status}`);
  const bytes = Buffer.from(await tarball.arrayBuffer());
  if (sha256(bytes) !== item.sha256) throw new Error(`Existing registry bytes differ: ${item.package}@${item.version}`);
  if (version.dist.integrity !== 'sha512-' + createHash('sha512').update(bytes).digest('base64'))
    throw new Error(`Registry integrity differs: ${item.package}`);
  const manifest = item.manifest;
  for (const key of ['name', 'version', 'dependencies', 'peerDependencies'])
    if (!isDeepStrictEqual(version[key], manifest[key]))
      throw new Error(`Registry metadata differs: ${item.package} ${key}`);
  return true;
}
async function publishArtifacts({ root, selected, directory, registry, dryRun, legacyAngularjs }) {
  registry = localRegistry(registry);
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
    throw new Error('Artifact rehearsal requires a clean committed checkout.');
  const load = (name) => import(pathToFileURL(path.join(root, 'tools', name)).href);
  const { validatePackageArtifactsContract, validatePackageArtifactsEvidence } = await load(
    'package-artifacts-lib.mjs'
  );
  await validatePackageArtifactsContract({ root });
  await validatePackageArtifactsEvidence({ root });
  const { validateCiPackageInput } = await load('ci-package-input-lib.mjs');
  const artifacts = validateCiPackageInput(directory, { repository: root }).map((item) => ({
    ...item,
    manifest: packedManifest(item.path),
  }));
  for (const item of artifacts) {
    if (item.manifest.name !== item.package || item.manifest.version !== item.version)
      throw new Error('Staged manifest identity differs.');
    if (item.manifest.publishConfig) throw new Error(`Review publishConfig before rehearsal: ${item.package}`);
  }
  const ordered = orderedArtifacts(artifacts, selected);
  if (legacyAngularjs && !ordered.some((item) => item.package === '@uirouter/angularjs'))
    throw new Error('Legacy AngularJS publication requires the scoped AngularJS artifact.');
  const preview = {
    mode: dryRun ? 'read-only-artifact-rehearsal' : 'local-artifact-rehearsal',
    registry,
    tag: 'rehearsal',
    packages: ordered.map(({ package: name, version, sha256 }) => ({ name, version, sha256 })),
  };
  if (legacyAngularjs)
    preview.packages.push({
      name: 'angular-ui-router',
      version: ordered.find((item) => item.package === '@uirouter/angularjs').version,
      derivedFrom: '@uirouter/angularjs',
    });
  if (dryRun) return preview;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'uirouter-artifact-release-'));
  try {
    const config = path.join(temporary, 'npmrc');
    fs.writeFileSync(
      config,
      `registry=${registry}\n@uirouter:registry=${registry}\n//127.0.0.1:${
        new URL(registry).port
      }/:_authToken=local-rehearsal-only\nignore-scripts=true\naudit=false\nfund=false\nprovenance=false\n`
    );
    const env = {
      PATH: process.env.PATH,
      npm_config_userconfig: config,
      npm_config_globalconfig: '/dev/null',
      npm_config_cache: path.join(temporary, 'cache'),
    };
    const npm = (...args) =>
      execFileSync('npm', args, { cwd: temporary, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    // Copy all validated inputs before any network write. Never publish a file
    // that can change in the staging directory during a resumable operation.
    const inputs = ordered.map((item) => {
      const target = path.join(temporary, path.basename(item.path));
      const bytes = fs.readFileSync(item.path);
      if (sha256(bytes) !== item.sha256) throw new Error('Staged artifact changed after validation.');
      fs.writeFileSync(target, bytes);
      return { ...item, path: target };
    });
    if (legacyAngularjs) {
      const scoped = inputs.find((item) => item.package === '@uirouter/angularjs');
      const members = execFileSync('tar', ['-tzf', scoped.path], { encoding: 'utf8' }).trim().split('\n');
      if (members.some((name) => !name.startsWith('package/') || name.split('/').includes('..')))
        throw new Error('Unsafe legacy tar member.');
      const listing = execFileSync('tar', ['-tvzf', scoped.path], { encoding: 'utf8' }).trim().split('\n');
      if (listing.some((line) => !['-', 'd'].includes(line[0])))
        throw new Error('Legacy tarball must contain only files and directories.');
      const legacy = path.join(temporary, 'legacy');
      fs.mkdirSync(legacy);
      execFileSync('tar', ['-xzf', scoped.path, '-C', legacy]);
      const manifest = { ...scoped.manifest, name: 'angular-ui-router' };
      fs.writeFileSync(path.join(legacy, 'package/package.json'), JSON.stringify(manifest, null, 2) + '\n');
      const packed = JSON.parse(
        npm('pack', path.join(legacy, 'package'), '--ignore-scripts', '--json', '--pack-destination', temporary)
      )[0];
      const file = path.join(temporary, packed.filename);
      const renamedMembers = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
      if (JSON.stringify([...members].sort()) !== JSON.stringify(renamedMembers.sort()))
        throw new Error('Legacy packed inventory differs.');
      for (const member of members.filter((name) => name !== 'package/package.json' && !name.endsWith('/')))
        if (
          !execFileSync('tar', ['-xOf', scoped.path, member], { maxBuffer: 16 * 1024 * 1024 }).equals(
            execFileSync('tar', ['-xOf', file, member], { maxBuffer: 16 * 1024 * 1024 })
          )
        )
          throw new Error(`Legacy packed bytes differ: ${member}`);
      inputs.push({
        package: manifest.name,
        version: manifest.version,
        manifest,
        path: file,
        sha256: sha256(fs.readFileSync(file)),
      });
    }
    preview.results = [];
    for (const item of inputs) {
      const existing = await readback(registry, item);
      if (!existing) {
        npm(
          'publish',
          item.path,
          '--registry',
          registry,
          '--tag',
          'rehearsal',
          '--ignore-scripts',
          '--provenance=false',
          '--json'
        );
        if (!(await readback(registry, item))) throw new Error(`Published version not readable: ${item.package}`);
      }
      preview.results.push({
        name: item.package,
        version: item.version,
        sha256: item.sha256,
        action: existing ? 'verified-existing' : 'published-and-verified',
      });
      console.error(`ARTIFACT_REHEARSAL_OK ${item.package}@${item.version} ${preview.results.at(-1).action}`);
    }
    return preview;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
module.exports = { localRegistry, orderedArtifacts, readback, publishArtifacts };
