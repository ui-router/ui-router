import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRetryFetch } from '../.github/release-please/retry-fetch.mjs';
import { createDraftProposals, main, validateRunContext } from '../.github/release-please/run.mjs';

const { GitHub } = createRequire(new URL('../.github/release-please/package.json', import.meta.url))('release-please');
const url = 'https://api.github.com/repos/ui-router/ui-router/commits/example';
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

function harness(responses) {
  const calls = [], delays = [], warnings = [];
  const fetch = createRetryFetch({
    fetch: async (input, options) => {
      calls.push([String(input), options]);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'unexpected request');
      return response;
    },
    sleep: async ms => { delays.push(ms); },
    now: () => 1_000_000,
    warn: text => warnings.push(text),
  });
  return { fetch, calls, delays, warnings };
}

test('an HTTP 422 commit timeout retries the failed page through the real library without restarting successful pages', async () => {
  const next = `${url}?page=2`;
  const h = harness([
    json({ files: [{ filename: 'core/a.ts' }] }, 200, { link: `<${next}>; rel="next"` }),
    json({ message: 'The request is taking too long to generate.' }, 422),
    json({ files: [{ filename: 'core/b.ts' }] }),
  ]);
  const github = await GitHub.create({ owner: 'ui-router', repo: 'ui-router', defaultBranch: 'main', token: 'fixture-token', fetch: h.fetch });
  assert.deepEqual(await github.getCommitFiles('example'), ['core/a.ts', 'core/b.ts']);
  assert.deepEqual(h.calls.map(([input]) => input), [url, next, next]);
  assert.deepEqual(h.delays, [1000]);
  assert.ok(h.warnings.some(text => text.includes('HTTP 422')));
  assert.ok(h.warnings.every(text => !text.includes('fixture-token')));
});

test('ordinary HTTP 422 errors preserve their bodies and the timeout exception is restricted to commit reads', async () => {
  const invalid = harness([json({ message: 'Validation Failed' }, 422)]);
  const response = await invalid.fetch(url);
  assert.deepEqual(await response.json(), { message: 'Validation Failed' });
  assert.deepEqual(invalid.delays, []);
  for (const [input, options] of [[url, { method: 'POST' }], [url.replace('/commits/example', '/pulls/1'), {}]]) {
    const h = harness([json({ message: 'The request is taking too long to generate.' }, 422)]);
    assert.equal((await h.fetch(input, options)).status, 422);
    assert.deepEqual(h.delays, []);
  }
});

function interruptedCommitPage() {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"files":[')); },
    pull(controller) { controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })); },
  });
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

test('a disconnect after HTTP 200 retries only the interrupted commit page', async () => {
  const next = `${url}?page=2`;
  const h = harness([
    json({ files: [{ filename: 'core/a.ts' }] }, 200, { link: `<${next}>; rel="next"` }),
    interruptedCommitPage(), json({ files: [{ filename: 'core/src/router.ts' }] }),
  ]);
  const github = await GitHub.create({ owner: 'ui-router', repo: 'ui-router', defaultBranch: 'main', token: 'fixture-token', fetch: h.fetch });
  assert.deepEqual(await github.getCommitFiles('example'), ['core/a.ts', 'core/src/router.ts']);
  assert.deepEqual(h.calls.map(([input]) => input), [url, next, next]);
});

test('unreadable or invalid commit pages fail the scan after retries', async () => {
  for (const makePage of [interruptedCommitPage, () => new Response('{"files":'), () => json({}), () => json({ files: [{}] })]) {
    const h = harness(Array.from({ length: 4 }, makePage));
    const github = await GitHub.create({ owner: 'ui-router', repo: 'ui-router', defaultBranch: 'main', token: 'fixture-token', fetch: h.fetch });
    await assert.rejects(github.getCommitFiles('example'));
    assert.deepEqual(h.delays, [1000, 2000, 4000]);
  }
  const empty = harness([json({ files: [] })]);
  const github = await GitHub.create({ owner: 'ui-router', repo: 'ui-router', defaultBranch: 'main', token: 'fixture-token', fetch: empty.fetch });
  assert.deepEqual(await github.getCommitFiles('example'), []);
  assert.deepEqual(empty.delays, []);
});

test('transient GET failures have bounded exponential retries and preserve the last error response', async () => {
  const h = harness([json({}, 502), json({}, 503), json({}, 504), json({}, 500)]);
  assert.equal((await h.fetch(url)).status, 500);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.delays, [1000, 2000, 4000]);
});

test('connection resets on reads recover, while permanent failures and writes do not retry', async () => {
  const reset = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
  const h = harness([reset, json({ files: [] })]);
  assert.equal((await h.fetch(url)).status, 200);
  assert.deepEqual(h.delays, [1000]);
  for (const status of [401, 403, 404, 422]) {
    const permanent = harness([json({}, status)]);
    assert.equal((await permanent.fetch(url)).status, status);
    assert.deepEqual(permanent.delays, []);
  }
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const write = harness([json({}, 502)]);
    assert.equal((await write.fetch(url, { method })).status, 502);
    assert.deepEqual(write.delays, []);
    const disconnected = harness([reset]);
    await assert.rejects(disconnected.fetch(url, { method }), error => error === reset);
    assert.deepEqual(disconnected.delays, []);
  }
});

test('rate limits wait until allowed, and excessive reset delays fail without retrying early', async () => {
  const h = harness([json({}, 429, { 'retry-after': '60' }), json({ files: [] })]);
  assert.equal((await h.fetch(url)).status, 200);
  assert.deepEqual(h.delays, [60_000]);
  const primary = harness([json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' }), json({ files: [] })]);
  assert.equal((await primary.fetch(url)).status, 200);
  assert.deepEqual(primary.delays, [60_000]);
  for (const headers of [{ 'retry-after': '120' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000' }]) {
    const limited = harness([json({}, 429, headers)]);
    assert.equal((await limited.fetch(url)).status, 429);
    assert.deepEqual(limited.delays, []);
  }
});

test('GraphQL query reads retry, while mutations and mixed-operation documents never retry', async () => {
  const graphql = 'https://api.github.com/graphql';
  const query = harness([json({}, 504), json({ data: {} })]);
  await query.fetch(graphql, { method: 'POST', body: JSON.stringify({ query: 'query History { repository { name } }' }) });
  assert.deepEqual(query.delays, [1000]);
  for (const document of [
    'mutation Create { createIssue { id } }',
    'query Read { viewer { login } } mutation Create { createIssue { id } }',
  ]) {
    const write = harness([json({}, 502)]);
    await write.fetch(graphql, { method: 'POST', body: JSON.stringify({ query: document }) });
    assert.deepEqual(write.delays, []);
  }
});

test('aborted reads and non-GitHub requests do not retry, and diagnostics omit credentials and query strings', async () => {
  const reset = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const aborted = harness([reset]);
  await assert.rejects(aborted.fetch(url, { signal: AbortSignal.abort() }), error => error === reset);
  assert.deepEqual(aborted.delays, []);
  const external = harness([json({}, 503)]);
  await external.fetch('https://example.com/resource');
  assert.deepEqual(external.delays, []);
  const diagnostics = harness([json({}, 503), json({ files: [] })]);
  await diagnostics.fetch(`${url}?secret=fixture-query`, { headers: { authorization: 'fixture-header' } });
  assert.ok(diagnostics.warnings.every(text => !/fixture-query|fixture-header/.test(text)));
});

test('proposal runner enforces draft configuration and never invokes release creation', async () => {
  const calls = [];
  const pullRequests = [{ number: 61 }];
  const manifest = {
    separatePullRequests: true, plugins: [], repositoryConfig: { core: { draftPullRequest: true } },
    createPullRequests: async () => { calls.push('prs'); return pullRequests; },
    createReleases: async () => { throw new Error('release creation is prohibited'); },
  };
  const Manifest = { fromManifest: async (_github, branch) => { assert.equal(branch, 'main'); return manifest; } };
  assert.deepEqual(await createDraftProposals({}, Manifest), pullRequests);
  manifest.repositoryConfig.core.draftPullRequest = false;
  await assert.rejects(createDraftProposals({}, Manifest), /requires separate draft PRs/);
  assert.deepEqual(calls, ['prs']);
  await assert.rejects(main({ GITHUB_REPOSITORY: 'ui-router/ui-router', GITHUB_REF: 'refs/heads/feature' }), /must run/);
});

test('maintainer dispatches can test branch code against main without enabling automatic branch runs', () => {
  const env = { GITHUB_REPOSITORY: 'ui-router/ui-router', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' };
  assert.doesNotThrow(() => validateRunContext(env));
  assert.doesNotThrow(() => validateRunContext({ ...env, GITHUB_REF: 'refs/heads/candidate', GITHUB_EVENT_NAME: 'workflow_dispatch' }));
  for (const blocked of [
    { ...env, GITHUB_REF: 'refs/heads/candidate' },
    { ...env, GITHUB_REF: 'refs/pull/63/merge', GITHUB_EVENT_NAME: 'pull_request' },
    { ...env, GITHUB_REF: 'refs/tags/test', GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { ...env, GITHUB_REPOSITORY: 'someone/fork', GITHUB_EVENT_NAME: 'workflow_dispatch' },
  ]) assert.throws(() => validateRunContext(blocked), /must run/);
});
