import { setTimeout } from 'node:timers/promises';

const transientStatuses = new Set([408, 500, 502, 503, 504]);
const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

function isRead(url, method, body) {
  if (url.origin !== 'https://api.github.com') return false;
  if (method === 'GET') return true;
  if (method !== 'POST' || url.pathname !== '/graphql' || typeof body !== 'string') return false;
  try {
    const query = JSON.parse(body).query;
    return typeof query === 'string' && /^\s*(query\b|\{)/.test(query) && !/\b(mutation|subscription)\b/.test(query);
  } catch { return false; }
}

class InvalidCommitPage extends Error {}

async function validateCommitPage(response) {
  // Octokit consumes the original stream later and can turn a failed JSON read
  // into an empty string. Finish reading a copy while this page can still retry.
  const text = await response.clone().text();
  let page;
  try {
    page = JSON.parse(text);
  } catch {
    throw new InvalidCommitPage('Invalid JSON in commit file list');
  }
  if (response.status !== 200 || !response.headers.get('content-type')?.includes('application/json') ||
      !Array.isArray(page?.files) || !page.files.every(file => typeof file?.filename === 'string' && file.filename.length > 0)) {
    throw new InvalidCommitPage('Invalid GitHub commit file list');
  }
}

async function isCommitGenerationTimeout(response) {
  try {
    const { message } = await response.clone().json();
    return typeof message === 'string' && /^The request is taking too long to generate\.?$/i.test(message.trim());
  } catch { return false; }
}

function retryDelay(response, attempt, now, generationTimeout) {
  const limited = response.status === 429 || (response.status === 403 && (
    response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
  ));
  if (!limited && !transientStatuses.has(response.status) && !generationTimeout) return;
  const retryAfter = response.headers.get('retry-after');
  let requiredDelay = 0;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    requiredDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now();
  }
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (!reset) return; // Do not guess when an exhausted primary quota resets.
    requiredDelay = Math.max(requiredDelay, reset * 1000 - now());
  }
  if (!Number.isFinite(requiredDelay)) return;
  const delay = Math.max(requiredDelay, limited ? 60_000 * 2 ** attempt : 1000 * 2 ** attempt);
  // A longer pause should fail visibly instead of consuming the App token's lifetime.
  return delay <= 60_000 ? delay : undefined;
}

export function createRetryFetch({ fetch = globalThis.fetch, sleep = setTimeout, now = Date.now, warn = console.warn } = {}) {
  return async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (options.method ?? input.method ?? 'GET').toUpperCase();
    const retryable = isRead(url, method, options.body);
    const commitRead = retryable && method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+\/?$/.test(url.pathname);
    const label = `${method} ${url.pathname}`;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(input, options);
        if (commitRead && response.ok) await validateCommitPage(response);
      } catch (error) {
        await response?.body?.cancel().catch(() => {});
        const code = error.cause?.code ?? error.code;
        const recoverable = error instanceof InvalidCommitPage || transientCodes.has(code);
        if (!retryable || attempt === 3 || options.signal?.aborted || !recoverable) throw error;
        const delay = 1000 * 2 ** attempt;
        warn(`${label}: ${code ?? error.message}; retry ${attempt + 1}/3 in ${delay}ms`);
        await sleep(delay, undefined, { signal: options.signal });
        continue;
      }
      if (!response.ok) warn(`${label}: HTTP ${response.status} (attempt ${attempt + 1})`);
      const generationTimeout = commitRead && response.status === 422 && attempt < 3 && await isCommitGenerationTimeout(response);
      const delay = retryable && attempt < 3 ? retryDelay(response, attempt, now, generationTimeout) : undefined;
      if (delay === undefined) return response;
      await response.body?.cancel();
      warn(`${label}: retry ${attempt + 1}/3 in ${delay}ms`);
      await sleep(delay, undefined, { signal: options.signal });
    }
  };
}
