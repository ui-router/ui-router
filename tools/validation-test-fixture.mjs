import { execFileSync } from 'node:child_process';

// Archive/copy fixtures omit Git, but release plans need the actual ancestry and
// release tags. Clone shared objects read-only, with independent refs/indexes.
export function cloneValidationFixture(source, destination, revision) {
  const git = (root, ...args) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const commit = git(source, 'rev-parse', revision ?? 'HEAD');
  execFileSync('git', [
    '-c',
    'core.fsmonitor=false',
    'clone',
    '--shared',
    '--no-checkout',
    '--quiet',
    source,
    destination,
  ]);
  // Never inherit clone's default branch: linked worktrees and CI checkouts can
  // advertise a different default, or have no branch at all.
  git(destination, 'checkout', '--quiet', '-B', 'validation-fixture', commit);
  return commit;
}
