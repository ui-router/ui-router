import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRetryFetch } from './retry-fetch.mjs';

export async function createDraftProposals(github, Manifest) {
  const manifest = await Manifest.fromManifest(github, 'main', 'release-please-config.json', '.release-please-manifest.json');
  if (!manifest.separatePullRequests || Object.values(manifest.repositoryConfig).some(config => config.draftPullRequest !== true)) {
    throw new Error('Release proposal setup requires separate draft PRs for every package');
  }
  // This entry point intentionally calls only the proposal API, never createReleases().
  return manifest.createPullRequests();
}

export function validateRunContext(env) {
  const manualBranch = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF?.startsWith('refs/heads/');
  if (env.GITHUB_REPOSITORY !== 'ui-router/ui-router' || (env.GITHUB_REF !== 'refs/heads/main' && !manualBranch)) {
    throw new Error('Release proposals must run on main or an explicitly dispatched ui-router/ui-router branch');
  }
}

export async function main(env = process.env) {
  validateRunContext(env);
  if (!env.RELEASE_PLEASE_TOKEN) throw new Error('Missing Release Please App token');
  const { GitHub, Manifest } = createRequire(import.meta.url)('release-please');
  const github = await GitHub.create({
    owner: 'ui-router', repo: 'ui-router', defaultBranch: 'main',
    token: env.RELEASE_PLEASE_TOKEN, fetch: createRetryFetch(),
  });
  const pullRequests = await createDraftProposals(github, Manifest);
  console.log(`Release proposal PRs: ${pullRequests.map(pr => `#${pr.number}`).join(', ') || 'none'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Release proposals failed: ${error.name}; status=${error.status ?? 'unavailable'}; ${error.message || 'empty error response'}`);
    process.exitCode = 1;
  });
}
