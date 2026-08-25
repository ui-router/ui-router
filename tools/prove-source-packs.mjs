#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = realpathSync(path.resolve(import.meta.dirname, '..'));
const contract = JSON.parse(readFileSync(path.join(root, 'migration/source-aliases.json'), 'utf8'));
const consumerNames = new Map(contract.edges.map((edge) => [edge.consumer, JSON.parse(readFileSync(path.join(root, edge.consumer), 'utf8')).name]));
consumerNames.set('core/package.json', '@uirouter/core');

for (const [manifestPath, packageName] of [...consumerNames].sort((left, right) => left[1].localeCompare(right[1]))) {
  const packageRoot = path.dirname(manifestPath);
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', `--workspace=${packageName}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`SOURCE_PACK_FAILED package=${packageName}\n${result.stderr}`);
  let pack;
  try {
    [pack] = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`SOURCE_PACK_FAILED package=${packageName} invalid npm JSON: ${error.message}\n${result.stdout}`);
  }

  const packed = new Set(pack.files.map((entry) => entry.path));
  const consumerEdges = contract.edges.filter((edge) => edge.consumer === manifestPath);
  const adapterConfigs = new Set(consumerEdges
    .flatMap((edge) => Object.values(edge.adapters))
    .filter((adapter) => adapter !== 'not-applicable')
    .map((adapter) => path.relative(packageRoot, adapter.configPath).split(path.sep).join('/')));
  for (const config of adapterConfigs) {
    if (packed.has(config)) throw new Error(`SOURCE_PACK_FAILED package=${packageName} includes development source-alias adapter ${config}`);
  }

  const upstreamReferences = new Set();
  for (const upstream of consumerEdges.flatMap((edge) => [edge.sourceEntrypoint, ...edge.watchRoots])) {
    upstreamReferences.add(path.relative(packageRoot, upstream).split(path.sep).join('/'));
    upstreamReferences.add(path.join(root, upstream).split(path.sep).join('/'));
  }
  const forbiddenReferences = ['source-aliases.cjs', 'migration/source-aliases.json', root.split(path.sep).join('/'), ...upstreamReferences];
  for (const entry of pack.files) {
    const absolute = path.join(root, packageRoot, entry.path);
    if (!existsSync(absolute)) throw new Error(`SOURCE_PACK_FAILED package=${packageName} npm reported missing checkout file ${entry.path}`);
    const text = readFileSync(absolute).toString('utf8').split(path.sep).join('/');
    const leaked = forbiddenReferences.find((reference) => reference && text.includes(reference));
    if (leaked) throw new Error(`SOURCE_PACK_FAILED package=${packageName} file=${entry.path} contains development checkout/source reference ${leaked}`);
  }
  console.log(`SOURCE_PACK_OK package=${packageName} files=${pack.entryCount} bytes=${pack.unpackedSize}`);
}
console.log(`S02_SOURCE_PACK_PROOF_OK packages=${consumerNames.size}`);
