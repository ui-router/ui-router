#!/usr/bin/env node
// RP updates workspace versions; npm must update the shared root lock afterward.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function refreshReleaseLock(pr, { root, repository, branches, run = execute }) {
  if (!branches.includes(pr.head.ref) || pr.head.repo?.full_name !== repository ||
      pr.base.repo?.full_name !== repository || pr.base.ref !== 'main' ||
      !pr.labels.some(label => label.name === 'autorelease: pending') ||
      !/^[a-f0-9]{40}$/.test(pr.head.sha)) {
    throw new Error(`Refusing to update unexpected release PR #${pr.number}`);
  }
  const parent = mkdtempSync(path.join(os.tmpdir(), 'uirouter-release-lock-'));
  const checkout = path.join(parent, 'checkout');
  let added = false;
  try {
    run('git', ['fetch', 'origin', `refs/heads/${pr.head.ref}`], root);
    if (run('git', ['rev-parse', 'FETCH_HEAD'], root) !== pr.head.sha) {
      throw new Error(`PR #${pr.number} changed; rerun the workflow`);
    }
    run('git', ['worktree', 'add', '--detach', checkout, pr.head.sha], root);
    added = true;
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], checkout);
    const changed = run('git', ['diff', '--name-only'], checkout);
    if (!changed) return false;
    if (changed !== 'package-lock.json') throw new Error(`Unexpected npm changes in PR #${pr.number}: ${changed}`);
    run('git', ['add', '--', 'package-lock.json'], checkout);
    run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'chore: update shared package lock'], checkout);
    // Normal push rejects a changed remote branch; never overwrite someone else's work.
    run('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      'push', 'origin', `HEAD:refs/heads/${pr.head.ref}`], checkout);
    return true;
  } finally {
    if (added) run('git', ['worktree', 'remove', '--force', checkout], root);
    rmSync(parent, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(import.meta.dirname, '..');
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !process.env.GH_TOKEN) throw new Error('Run in Actions with GITHUB_REPOSITORY and the app GH_TOKEN');
  const config = JSON.parse(readFileSync(path.join(root, 'release-please-config.json'), 'utf8'));
  const branches = Object.values(config.packages).map(pkg => `release-please--branches--main--components--${pkg.component}`);
  // Include unchanged pending PRs, so a rerun can recover a failed lock update.
  const output = execute('gh', ['api', `repos/${repository}/pulls?state=open&base=main&per_page=100`, '--paginate', '--jq', '.[] | @json'], root);
  const prs = output ? output.split('\n').map(line => JSON.parse(line)) : [];
  for (const pr of prs.filter(pr => branches.includes(pr.head.ref) && pr.labels.some(label => label.name === 'autorelease: pending'))) {
    const changed = refreshReleaseLock(pr, { root, repository, branches });
    console.log(`PR #${pr.number}: ${changed ? 'updated shared lock' : 'shared lock already current'}`);
  }
}
