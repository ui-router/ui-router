#!/usr/bin/env node
// Test published tarballs in fresh directories outside the workspace graph.
import { spawnSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const config = read(path.join(root, 'tools/packages.json'));
const projects = read(path.join(root, 'tools/integration-projects.json'));
const selected = process.argv[2] ?? 'all';
if (!['all', 'packages', 'core', 'angular', 'angularjs', 'react', 'react-hybrid'].includes(selected)) throw new Error(`Unknown consumer group: ${selected}`);
const minimum = process.argv[3] === '--minimum';
if (process.argv.length > 4 || (process.argv[3] && !minimum) || (minimum && !['react', 'react-hybrid'].includes(selected))) {
  throw new Error('Use --minimum only with the react or react-hybrid consumer group');
}
const minimumVersions = new Map();
if (minimum) {
  const record = config.packages.find(record => record.id === selected);
  const manifest = read(path.join(root, record.manifest));
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    if (!config.packages.some(record => record.package === name)) continue;
    const match = /^\^(\d+\.\d+\.\d+)$/.exec(range);
    if (!match) throw new Error(`Expected a caret range for ${name}, got ${range}`);
    minimumVersions.set(name, match[1]);
  }
  console.log('Testing published minimum dependencies:', Object.fromEntries(minimumVersions));
}
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'uirouter-consumers-'));
const env = { ...process.env, CI: '1' };
delete env.NODE_PATH;
for (const key of ['npm_config_workspace', 'npm_config_workspaces', 'npm_config_local_prefix']) delete env[key];
function run(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${argv.join(' ')} failed in ${cwd}`);
}
const artifacts = new Map();
for (const record of config.packages) {
  const dir = path.join(root, path.dirname(record.manifest), '.artifacts/packages');
  const tarballs = readdirSync(dir).filter(file => file.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`Run npm run pack first: ${record.package}`);
  const target = path.join(sandbox, tarballs[0]);
  copyFileSync(path.join(dir, tarballs[0]), target);
  artifacts.set(record.package, target);
}
function install(cwd, manifest) {
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  run(['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], cwd);
  run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd);
  // Only explicitly selected minimum dependencies may come from npm; all others must use our tarballs.
  const lock = read(path.join(cwd, 'package-lock.json'));
  for (const [location, entry] of Object.entries(lock.packages)) {
    const name = location.split('node_modules/').at(-1);
    if (!artifacts.has(name)) continue;
    if (minimumVersions.has(name)) {
      if (entry.link || entry.version !== minimumVersions.get(name) || !entry.resolved?.startsWith('https://registry.npmjs.org/') || !entry.integrity) {
        throw new Error(`Expected published ${name}@${minimumVersions.get(name)}: ${location}`);
      }
      continue;
    }
    if (entry.link || !entry.resolved?.startsWith('file:')) throw new Error(`Registry fallback or workspace link for ${name}: ${location}`);
    const resolved = path.resolve(cwd, entry.resolved.slice(5));
    if (resolved !== artifacts.get(name)) throw new Error(`Wrong tarball for ${name}`);
    if (!realpathSync(path.join(cwd, location)).startsWith(cwd + path.sep)) throw new Error(`Package escapes consumer: ${name}`);
  }
  for (const [name, version] of minimumVersions) {
    if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Missing minimum dependency ${name}@${version}`);
  }
  run(['npm', 'ls', '--all'], cwd);
}
try {
  if (selected === 'all' || selected === 'packages') {
    const cwd = path.join(sandbox, 'packages');
    mkdirSync(cwd);
    const consumer = config.consumer;
    copyFileSync(path.join(root, 'tools/consumer-package-lock.json'), path.join(cwd, 'package-lock.json'));
    const dependencies = { ...consumer.dependencies, typescript: consumer.typecheck.typescript, [consumer.bundler.package]: consumer.bundler.version };
    for (const [name, file] of artifacts) dependencies[name] = `file:${file}`;
    install(cwd, { name: consumer.name, version: '0.0.0', private: true, type: 'module', dependencies });
    writeFileSync(path.join(cwd, 'runtime-probe.mjs'), runtimeProbeSource(config));
    writeFileSync(path.join(cwd, 'bundler-probe.ts'), bundlerProbeSource(config));
    writeFileSync(path.join(cwd, 'types-probe.ts'), typeProbeSource(config));
    writeFileSync(path.join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true, types: [] }, files: ['types-probe.ts'] }));
    run(['node', 'runtime-probe.mjs'], cwd);
    run(consumer.bundler.command, cwd);
    run(consumer.typecheck.command, cwd);
    const cli = config.packages.find(record => record.kind === 'cli');
    for (const entry of cli.entrypoints) {
      const bin = realpathSync(path.join(cwd, 'node_modules/.bin', entry.specifier));
      if (!bin.startsWith(path.join(cwd, 'node_modules', cli.package) + path.sep) || !readFileSync(bin, 'utf8').startsWith('#!')) throw new Error(`Invalid installed CLI: ${entry.specifier}`);
    }
  }
  for (const project of projects) {
    const group = project.id.startsWith('core/') ? 'core' : project.id.split('/')[1];
    if (selected !== 'all' && selected !== group) continue;
    const cwd = path.join(sandbox, project.id.replaceAll('/', '-'));
    cpSync(path.join(root, path.dirname(project.manifest)), cwd, { recursive: true, filter: filename => !['node_modules', 'dist', 'build', 'coverage', '.cache', '.turbo', 'test-results', 'playwright-report'].includes(path.basename(filename)) });
    const manifest = read(path.join(cwd, 'package.json'));
    for (const [name, section] of Object.entries(project.packages)) {
      manifest[section] ??= {};
      manifest[section][name] = minimumVersions.get(name) ?? `file:${artifacts.get(name)}`;
    }
    console.log(`Testing ${project.id}`);
    install(cwd, manifest);
    if (project.browser) run(['node_modules/.bin/playwright', 'install', 'chromium'], cwd);
    run(['npm', 'run', project.script], cwd);
  }
  rmSync(sandbox, { recursive: true, force: true });
} catch (error) {
  console.error(`Consumer files and failure reports retained at ${sandbox}`);
  throw error;
}

function runtimeProbeSource(contract) {
  const requireEntries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "require");
  const importEntries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "node-import");
  return `
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
require('angular/angular');
globalThis.angular = globalThis.window.angular;
const requireEntries = ${JSON.stringify(requireEntries)};
for (const entry of requireEntries) {
  const loaded = require(entry.specifier);
  if (!(entry.export in loaded)) throw new Error(entry.id + ' missing export ' + entry.export);
}
await import('@angular/compiler');
const importEntries = ${JSON.stringify(importEntries)};
for (const entry of importEntries) {
  const loaded = await import(entry.specifier);
  if (!(entry.export in loaded)) throw new Error(entry.id + ' missing export ' + entry.export);
}
const { UIRouter } = require('@uirouter/core');
const router = new UIRouter();
router.stateRegistry.register({ name: 'consumer', url: '/consumer' });
if (!router.stateRegistry.get('consumer')) throw new Error('core minimal router flow failed');
console.log('CONSUMER_RUNTIME_PROBES_OK require=' + requireEntries.length + ' import=' + importEntries.length);
`;
}

function bundlerProbeSource(contract) {
  const entries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "bundler-import");
  return `${entries
    .map(
      (entrypoint, index) =>
        `import { ${entrypoint.export} as value${index} } from ${JSON.stringify(
          entrypoint.specifier
        )};`
    )
    .join("\n")}\nconsole.log(${entries
    .map((_, index) => `Boolean(value${index})`)
    .join(" && ")});\n`;
}

function typeProbeSource(contract) {
  const entries = contract.packages
    .flatMap((record) => record.entrypoints)
    .filter((entrypoint) => entrypoint.mode === "types");
  return `${entries
    .map(
      (entrypoint, index) =>
        `import { ${
          entrypoint.export
        } as TypeValue${index} } from ${JSON.stringify(
          entrypoint.specifier
        )};\ntype CONSUMERType${index} = typeof TypeValue${index};`
    )
    .join("\n")}\nexport type CONSUMERTypes = ${entries
    .map((_, index) => `CONSUMERType${index}`)
    .join(" & ")};\n`;
}

