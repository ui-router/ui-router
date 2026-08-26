#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};
const run = (command, args, cwd, allowedStatuses = [0]) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      CI: '1',
      HUSKY: '0',
      LC_ALL: 'C',
      NODE_PATH: '',
      TZ: 'UTC',
      npm_config_ignore_scripts: 'true',
    },
  });
  if (!allowedStatuses.includes(result.status)) {
    fail(`${command} ${args.join(' ')} failed in ${cwd} (${result.status})\n${result.stderr}`);
  }
  return result;
};
const normalizeProblem = (problem, sandbox) => problem.replaceAll(`${sandbox}${sep}`, '<root>/').replaceAll(`${sandbox}/`, '<root>/');

const classification = readJson('migration/package-classification.json');
const pathRepairs = readJson('migration/path-repairs.json');
const expectedProblems = readJson('migration/evidence/n03/root-npm-ls-problems.json');
const expectedInternal = readJson('migration/evidence/n03/root-npm-ls-internal.json');
const movePath = (input) => {
  let output = input;
  for (const move of pathRepairs.moves) {
    if (output === move.from || output.startsWith(`${move.from}/`)) output = `${move.to}${output.slice(move.from.length)}`;
  }
  return output;
};

if (process.version !== 'v24.19.0') fail(`Node must be v24.19.0, got ${process.version}`);
const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
if (npmVersion !== '11.17.0') fail(`npm must be 11.17.0, got ${npmVersion}`);
const gitArgs = ['-c', `safe.directory=${root}`, '-C', root];
const statusBefore = execFileSync('git', [...gitArgs, 'status', '--porcelain=v1'], { encoding: 'utf8' });
const sandboxRoot = mkdtempSync(join(tmpdir(), 'uirouter-n03-proof-'));
if (realpathSync(sandboxRoot).startsWith(`${realpathSync(root)}${sep}`)) fail('sandbox is inside repository ancestry');

try {
  const rootSandbox = join(sandboxRoot, 'root');
  cpSync(root, rootSandbox, {
    recursive: true,
    filter: (source) => {
      const name = source.split(sep).at(-1);
      return !['.git', '.migration-work', 'node_modules'].includes(name);
    },
  });
  const rootLock = join(rootSandbox, 'package-lock.json');
  const rootLockBefore = sha256(rootLock);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], rootSandbox);
  const npmLs = run('npm', ['ls', '--all', '--json'], rootSandbox, [0, 1]);
  const npmLsJson = JSON.parse(npmLs.stdout);
  const problems = (npmLsJson.problems ?? []).map((problem) => normalizeProblem(problem, rootSandbox));
  if (npmLs.status !== expectedProblems.exitStatus || JSON.stringify(problems) !== JSON.stringify(expectedProblems.problems)) {
    fail('root npm ls problem set differs from the reviewed S01 waiver');
  }
  run(process.execPath, [join(root, 'tools/verify-npm-locks.mjs'), '--installed-root', rootSandbox], root);

  const internal = [];
  for (const record of classification.manifests.filter((candidate) => candidate.published)) {
    const manifestPath = movePath(record.path);
    const manifest = readJson(manifestPath);
    const installed = npmLsJson.dependencies?.[manifest.name];
    if (!installed || installed.invalid || installed.overridden || !installed.resolved?.startsWith('file:')) {
      fail(`npm ls did not report a valid workspace link for ${manifest.name}`);
    }
    internal.push({
      package: manifest.name,
      version: installed.version,
      npmLsResolved: installed.resolved,
      workspacePath: dirname(manifestPath),
      invalid: false,
      overridden: false,
    });
  }
  internal.sort((left, right) => left.package.localeCompare(right.package));
  if (JSON.stringify(internal) !== JSON.stringify(expectedInternal.packages)) fail('root npm ls internal package proof differs');

  const localRuns = [];
  for (const record of classification.manifests.filter((candidate) => candidate.lockOwner === 'local')) {
    const manifestPath = movePath(record.path);
    const fixtureSandbox = join(rootSandbox, dirname(manifestPath));
    rmSync(join(fixtureSandbox, 'node_modules'), { recursive: true, force: true });
    const lockPath = join(fixtureSandbox, 'package-lock.json');
    const lockBefore = sha256(lockPath);
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], fixtureSandbox);
    const localNpmLs = run('npm', ['ls', '--all', '--json'], fixtureSandbox);
    const localNpmLsJson = JSON.parse(localNpmLs.stdout);
    localRuns.push({
      manifest: manifestPath,
      lock: `${dirname(manifestPath)}/package-lock.json`,
      lockSha256: lockBefore,
      sandboxOutsideRepositoryAncestry: !realpathSync(fixtureSandbox).startsWith(`${realpathSync(root)}${sep}`),
      command: 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error',
      ciExitStatus: 0,
      npmLsCommand: 'npm ls --all --json',
      npmLsExitStatus: 0,
      npmLsProblemCount: (localNpmLsJson.problems ?? []).length,
      lockUnchanged: sha256(lockPath) === lockBefore,
    });
  }
  localRuns.sort((left, right) => left.manifest.localeCompare(right.manifest));
  const installedOrigins = run(
    process.execPath,
    [join(root, 'tools/verify-internal-deps.mjs'), '--installed-root', rootSandbox],
    root,
  ).stdout.trim();
  if (!/^INTERNAL_DEPS_VERIFY_OK .* installed=verified$/.test(installedOrigins)) {
    fail(`installed-origin verifier returned an unexpected summary: ${installedOrigins}`);
  }

  const proof = {
    schemaVersion: 1,
    runtime: { node: process.version, npm: npmVersion, timezone: 'UTC', locale: 'C' },
    sandboxOutsideRepositoryAncestry: !realpathSync(sandboxRoot).startsWith(`${realpathSync(root)}${sep}`),
    root: {
      lock: 'package-lock.json',
      lockSha256: rootLockBefore,
      command: 'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error',
      ciExitStatus: 0,
      npmLsCommand: 'npm ls --all --json',
      npmLsExitStatus: npmLs.status,
      npmLsProblemCount: problems.length,
      npmLsInternalWorkspacePackages: internal.length,
      installedOriginVerifier: installedOrigins,
      lockUnchanged: sha256(rootLock) === rootLockBefore,
    },
    localRuns,
    sourceTreeUnchanged: true,
  };
  const outputFlag = process.argv.indexOf('--write');
  const expectedFlag = process.argv.indexOf('--expected');
  if (outputFlag !== -1 && expectedFlag !== -1) fail('--write and --expected are mutually exclusive');
  if (outputFlag !== -1 && !process.argv[outputFlag + 1]) fail('--write requires an output path');
  if (expectedFlag !== -1 && !process.argv[expectedFlag + 1]) fail('--expected requires an evidence path');
  const outputPath = outputFlag === -1 ? null : resolve(root, process.argv[outputFlag + 1] ?? '');
  const expectedPath = expectedFlag === -1 ? null : resolve(root, process.argv[expectedFlag + 1] ?? '');
  if (outputPath) {
    writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`);
  } else {
    const comparisonPath = expectedPath ?? join(root, 'migration/evidence/n03/install-proof.json');
    const expected = JSON.parse(readFileSync(comparisonPath, 'utf8'));
    if (JSON.stringify(proof) !== JSON.stringify(expected)) fail(`install proof differs from ${relative(root, comparisonPath)}`);
  }
  const statusAfter = execFileSync('git', [...gitArgs, 'status', '--porcelain=v1'], { encoding: 'utf8' });
  if (statusAfter !== statusBefore && !outputPath) fail('proof mutated the source tree');
  console.log(`NPM_INSTALL_PROOF_OK root=1 local=${localRuns.length} internal=${internal.length} npmLsProblems=${problems.length}`);
} finally {
  rmSync(sandboxRoot, { recursive: true, force: true });
}
