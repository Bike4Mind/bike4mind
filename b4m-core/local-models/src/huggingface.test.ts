import type { ServerResponse } from 'node:http';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HubAccessError,
  HubRateLimitError,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeConnectionError,
  RuntimeHttpError,
  RuntimeProtocolError,
} from './errors';
import {
  HUB_CACHE_TTL_MS,
  HuggingFaceHub,
  MAX_VERIFY_TAGS,
  clearHubCache,
  findHubBuild,
  ggufQuantLabel,
  hubBuildTag,
  hubResolveUrl,
  type HubModelDetail,
} from './huggingface';
import { closedPort, hang, json, startFakeServer, type FakeServer, type Handler } from './__test__/fakeServer';
import {
  gatedInfo,
  gatedMessage,
  gatedSha,
  gatedTree,
  flashNextSha,
  flashNextTree,
  lfmSha,
  lfmTree,
  qwenInfo,
  qwenSha,
  qwenTree,
  searchCursor,
  searchPage,
  vlInfo,
  vlSha,
  vlTreePages,
} from './__test__/huggingFaceFixtures';

const TOKEN = 'hf_TestTokenThatMustNeverLeak0123456789';

const servers: FakeServer[] = [];

beforeEach(clearHubCache);

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function serve(routes: Record<string, Handler>): Promise<FakeServer> {
  const server = await startFakeServer(routes);
  servers.push(server);
  return server;
}

function reply(response: ServerResponse, status: number, headers: Record<string, string>, body = ''): void {
  response.writeHead(status, headers);
  response.end(body);
}

const withHeaders =
  (body: unknown, headers: Record<string, string>, status = 200): Handler =>
  (_request, response) =>
    reply(response, status, { 'content-type': 'application/json', ...headers }, JSON.stringify(body));

const query = (path: string) => new URL(path, 'http://x').searchParams;

const repoRoutes = (repo: string, sha: string, info: unknown, tree: unknown): Record<string, Handler> => ({
  [`GET /api/models/${repo}/revision/main`]: json(info),
  [`GET /api/models/${repo}/revision/${sha}`]: json(info),
  [`GET /api/models/${repo}/tree/${sha}`]: json(tree),
});

async function caught(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

function expectNoToken(error: Error, token = TOKEN): void {
  const text = `${error.message} ${String(error.cause)} ${JSON.stringify(error)} ${inspect(error, { depth: 10 })}`;
  expect(text).not.toContain(token);
  expect(text).not.toMatch(/Bearer hf_/);
}

describe('ggufQuantLabel', () => {
  it.each([
    ['qwen2.5-0.5b-instruct-q4_k_m.gguf', 'Q4_K_M'],
    ['SmolLM2-135M-Instruct-f16.gguf', 'F16'],
    ['qwen2.5-0.5b-instruct-fp16.gguf', null],
    ['SmolLM2-135M-Instruct-Q4_K_L.gguf', 'Q4_K_L'],
    ['Qwen2.5-0.5B-Instruct-Q5_K_L.gguf', 'Q5_K_L'],
    ['Qwen2.5-0.5B-Instruct-Q6_K_L.gguf', 'Q6_K_L'],
    ['Qwen2.5-0.5B-Instruct-IQ4_NL.gguf', 'IQ4_NL'],
    ['Qwen2.5-0.5B-Instruct-IQ3_XS.gguf', 'IQ3_XS'],
    ['Qwen3-0.6B-UD-IQ2_M.gguf', 'UD-IQ2_M'],
    ['Qwen3-0.6B-UD-Q2_K_XL.gguf', 'UD-Q2_K_XL'],
    ['Qwen3-0.6B-UD-Q8_K_XL.gguf', 'UD-Q8_K_XL'],
    ['SmolLM2-135M-Instruct-Q2_K_L.gguf', 'Q2_K_L'],
    ['SmolLM2-135M-Instruct-Q4_0.gguf', 'Q4_0'],
    ['SmolLM2-135M-Instruct-Q4_0_4_4.gguf', 'Q4_0_4_4'],
    ['SmolLM2-135M-Instruct-Q3_K_XL.gguf', 'Q3_K_XL'],
    ['SmolLM2-135M-Instruct-IQ2_XXS.gguf', 'IQ2_XXS'],
    ['gemma-3-27b-it-UD-Q4_K_XL.gguf', 'UD-Q4_K_XL'],
    ['gpt-oss-20b-MXFP4.gguf', 'MXFP4'],
    ['gpt-oss-20b-MXFP4_MOE.gguf', 'MXFP4_MOE'],
    ['BF16/Qwen2.5-VL-72B-Instruct-BF16-00002-of-00003.gguf', 'BF16'],
    ['Q8_0/model-F16-imported-Q8_0.gguf', 'Q8_0'],
  ])('labels %s as %s', (name, label) => {
    expect(ggufQuantLabel(name)).toBe(label);
  });
});

describe('hubResolveUrl', () => {
  it('encodes each path segment and the revision', () => {
    expect(hubResolveUrl('unsloth/gemma-3-27b-it-GGUF', vlSha, 'BF16/a b#1.gguf')).toBe(
      `https://huggingface.co/unsloth/gemma-3-27b-it-GGUF/resolve/${vlSha}/BF16/a%20b%231.gguf`
    );
    expect(hubResolveUrl('a/b', 'refs/pr/1', 'x.gguf', 'http://127.0.0.1:9/hf/')).toBe(
      'http://127.0.0.1:9/hf/a/b/resolve/refs%2Fpr%2F1/x.gguf'
    );
  });

  it.each([
    ['../etc', 'main', 'x.gguf'],
    ['a/b/c', 'main', 'x.gguf'],
    ['a/b', '../main', 'x.gguf'],
    ['a/b', 'main', '../x.gguf'],
    ['a/b', 'main', ''],
  ])('rejects repo %s revision %s path %s', (repo, revision, path) => {
    expect(() => hubResolveUrl(repo, revision, path)).toThrow(LocalRuntimeError);
  });

  it('rejects an endpoint with credentials without echoing them', () => {
    expect(() => new HuggingFaceHub({ endpoint: 'https://user:secret@huggingface.co' })).toThrow(
      /^Invalid Hugging Face endpoint$/
    );
  });
});

describe('HuggingFaceHub.search', () => {
  it('asks for GGUF repos with the summary fields and follows the Link cursor', async () => {
    const server = await serve({
      'GET /api/models': withHeaders(searchPage, {
        link: `<https://huggingface.co/api/models?search=qwen2.5+0.5b&filter=gguf&cursor=${searchCursor}>; rel="next"`,
      }),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const page = await hub.search({ query: '  qwen2.5 0.5b ', sort: 'trending', limit: 2 });

    const params = query(server.requests[0]?.path ?? '');
    expect(params.get('search')).toBe('qwen2.5 0.5b');
    expect(params.get('filter')).toBe('gguf');
    expect(params.get('sort')).toBe('trendingScore');
    expect(params.get('limit')).toBe('2');
    expect(params.getAll('expand[]')).toEqual(expect.arrayContaining(['gated', 'lastModified', 'tags', 'author']));
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
    expect(page.nextCursor).toBe(searchCursor);
    expect(page.models).toEqual([
      {
        id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
        author: 'Qwen',
        downloads: 325006,
        likes: 157,
        updatedAt: '2024-09-20T06:20:24.000Z',
        pipelineTag: 'text-generation',
        gated: false,
        private: false,
        licenses: ['apache-2.0'],
        baseModels: ['Qwen/Qwen2.5-0.5B-Instruct'],
        tags: ['gguf', 'chat', 'text-generation', 'en', 'conversational'],
      },
      expect.objectContaining({ id: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF', author: 'bartowski', updatedAt: null }),
    ]);

    await hub.search({ query: 'qwen2.5 0.5b', sort: 'trending', limit: 2, cursor: page.nextCursor ?? '' });
    expect(query(server.requests[1]?.path ?? '').get('cursor')).toBe(searchCursor);
  });

  it('maps every sort, clamps the limit, and drops entries it cannot read', async () => {
    const server = await serve({
      'GET /api/models': json([{ id: 'no-owner' }, { downloads: 3 }, 'junk', ...searchPage, ...searchPage]),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const sorts = { downloads: 'downloads', likes: 'likes', trending: 'trendingScore', updated: 'lastModified' };
    for (const [sort, param] of Object.entries(sorts)) {
      await hub.search({ sort: sort as keyof typeof sorts, limit: 1000 });
      const params = query(server.requests.at(-1)?.path ?? '');
      expect([params.get('sort'), params.get('limit'), params.has('search')]).toEqual([param, '100', false]);
    }
    const page = await hub.search({ limit: 0 });
    expect(query(server.requests.at(-1)?.path ?? '').get('limit')).toBe('1');
    expect(page).toEqual({ models: [], nextCursor: null });
    expect((await hub.search({ limit: 5 })).models.map(model => model.id)).toEqual([
      'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
      'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
    ]);
  });
});

describe('HuggingFaceHub cache', () => {
  const repo = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';

  it('serves a repeated search and model read from cache for 10 minutes, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = await serve({
      'GET /api/models': json(searchPage),
      ...repoRoutes(repo, qwenSha, qwenInfo, qwenTree),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const first = await hub.search({ query: 'qwen' });
    expect(await hub.search({ query: 'qwen' })).toEqual(first);
    await hub.getModel(repo);
    await hub.getModel(repo);
    expect(server.requests).toHaveLength(3);

    vi.advanceTimersByTime(HUB_CACHE_TTL_MS - 1);
    await hub.search({ query: 'qwen' });
    expect(server.requests).toHaveLength(3);
    vi.advanceTimersByTime(1);
    await hub.search({ query: 'qwen' });
    await hub.getModel(repo);
    expect(server.requests).toHaveLength(6);
  });

  it('keys on the query, cursor and revision, and refresh bypasses the cache', async () => {
    const server = await serve({
      'GET /api/models': json(searchPage),
      ...repoRoutes(repo, qwenSha, qwenInfo, qwenTree),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    await hub.search({ query: 'a' });
    await hub.search({ query: 'b' });
    await hub.search({ query: 'a', cursor: 'next' });
    expect(server.requests).toHaveLength(3);
    await hub.search({ query: 'a', refresh: true });
    await hub.search({ query: 'a' });
    expect(server.requests).toHaveLength(4);
    await hub.getModel(repo, { refresh: true });
    const before = server.requests.length;
    await hub.getModel(repo);
    expect(server.requests).toHaveLength(before);
  });

  it('never reuses an anonymous result for a token, or one token for another', async () => {
    const server = await serve({ 'GET /api/models': json(searchPage) });
    const anonymous = new HuggingFaceHub({ endpoint: server.baseUrl });
    const one = new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN });
    const two = new HuggingFaceHub({ endpoint: server.baseUrl, token: `${TOKEN}2` });
    await anonymous.search();
    await one.search();
    await two.search();
    expect(server.requests).toHaveLength(3);
    expect(server.requests.map(request => request.headers.authorization)).toEqual([
      undefined,
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}2`,
    ]);
    await new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN }).search();
    await anonymous.search();
    expect(server.requests).toHaveLength(3);
  });

  it('does not cache errors', async () => {
    let calls = 0;
    const server = await serve({
      'GET /api/models': (_request, response) => {
        calls++;
        if (calls === 1) return reply(response, 500, {}, 'boom');
        return json(searchPage)(_request, response);
      },
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    await expect(hub.search()).rejects.toBeInstanceOf(RuntimeHttpError);
    expect((await hub.search()).models.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
  });

  it('honors cancellation even when search and model answers are cached', async () => {
    const server = await serve({
      'GET /api/models': json(searchPage),
      ...repoRoutes(repo, qwenSha, qwenInfo, qwenTree),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    await hub.search();
    await hub.getModel(repo);
    const signal = AbortSignal.abort();

    await expect(hub.search({ signal })).rejects.toBe(signal.reason);
    await expect(hub.getModel(repo, { signal })).rejects.toBe(signal.reason);
    expect(server.requests).toHaveLength(3);
  });

  it('hands out copies, so a caller that edits a result does not change the next one', async () => {
    const server = await serve({ 'GET /api/models': json(searchPage) });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const first = await hub.search();
    const id = first.models[0]?.id;
    first.models.length = 0;
    expect((await hub.search()).models[0]?.id).toBe(id);
  });
});

describe('HuggingFaceHub rate limit backoff', () => {
  const limited = (retryAfter: string) => () =>
    new Response('{"error":"Too many requests"}', { status: 429, headers: { 'retry-after': retryAfter } });
  const ok = () => new Response(JSON.stringify(searchPage), { headers: { 'content-type': 'application/json' } });
  const hubWith = (responses: (() => Response)[], options: { maxRateLimitWaitMs?: number } = {}) => {
    const fetch = vi.fn(async () => (responses.shift() ?? ok)());
    return { fetch, hub: new HuggingFaceHub({ fetch, ...options }) };
  };

  it.each([
    ['seconds', () => '2'],
    ['an HTTP date', () => new Date(Date.now() + 2000).toUTCString()],
  ])('retries a 429 after Retry-After given as %s, then succeeds', async (_name, header) => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const { fetch, hub } = hubWith([limited(header())]);
    const pending = hub.search();
    await vi.advanceTimersByTimeAsync(1900);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).models.length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('backs off exponentially when the 429 names no wait', async () => {
    vi.useFakeTimers();
    const none = () => new Response('', { status: 429 });
    const { fetch, hub } = hubWith([none, none]);
    const pending = hub.search();
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('surfaces HubRateLimitError once the total wait would pass the cap', async () => {
    vi.useFakeTimers();
    const { fetch, hub } = hubWith([limited('1'), limited('1'), limited('1')], { maxRateLimitWaitMs: 2500 });
    const error = caught(hub.search());
    await vi.advanceTimersByTimeAsync(2000);
    expect(await error).toBeInstanceOf(HubRateLimitError);
    expect(await error).toMatchObject({ status: 429, retryAfterMs: 1000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not wait at all when Retry-After is longer than the cap', async () => {
    const { fetch, hub } = hubWith([limited('30')]);
    expect(await caught(hub.search())).toMatchObject({ name: 'HubRateLimitError', retryAfterMs: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['0', 'Thu, 01 Jan 1970 00:00:00 GMT'])(
    'does not retry with retries disabled even for Retry-After %s',
    async header => {
      const { fetch, hub } = hubWith([limited(header)], { maxRateLimitWaitMs: 0 });
      await expect(hub.search()).rejects.toBeInstanceOf(HubRateLimitError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('honors the request deadline during backoff without sending another request', async () => {
    const fetch = vi.fn(async (_input: string, options?: RequestInit) => {
      options?.signal?.throwIfAborted();
      return limited('3')();
    });
    const hub = new HuggingFaceHub({ fetch, requestTimeoutMs: 30 });
    const started = performance.now();

    await expect(hub.search()).rejects.toBeInstanceOf(RuntimeConnectionError);

    expect(performance.now() - started).toBeLessThan(1000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the caller aborts, without another request', async () => {
    vi.useFakeTimers();
    const { fetch, hub } = hubWith([limited('3')]);
    const controller = new AbortController();
    const error = caught(hub.search({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    expect(await error).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('HuggingFaceHub install guard', () => {
  const file = (path: string, url?: string) => ({
    path,
    sizeBytes: 1,
    sha256: null,
    url: url ?? hubResolveUrl('a/b', 'main', path),
  });

  it.each(['pytorch_model.bin', 'model.pt', 'model.pth', 'model.ckpt', 'model.safetensors', 'sub/model.gguf.bin', 'x'])(
    'refuses to download %s before any request',
    async path => {
      const server = await serve({});
      const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
      const error = await caught(
        hub.download(file(path, `${server.baseUrl}/a/b/resolve/main/${path}`), '/nonexistent/x')
      );
      expect(error).toBeInstanceOf(LocalRuntimeError);
      expect(error.message).toContain('Only .gguf files can be installed');
      expect(server.requests).toEqual([]);
    }
  );

  it('refuses a .gguf name whose resolve URL points at another kind of file', async () => {
    const hub = new HuggingFaceHub();
    const error = await caught(
      hub.download(file('model.gguf', hubResolveUrl('a/b', 'main', 'model.bin')), '/nonexistent/x')
    );
    expect(error.message).toContain('Only .gguf files can be installed');
  });

  it('refuses to verify an Ollama ref for a build that holds a non-GGUF file', async () => {
    const hub = new HuggingFaceHub();
    const build = {
      id: 'model',
      quant: 'Q4_K_M',
      files: [{ ...file('model.bin'), sha256: 'a'.repeat(64) }],
      sizeBytes: 1,
      split: false,
      complete: true,
      ollamaRef: null,
      ollamaRefIssue: null,
    };
    const error = await caught(hub.verifyOllamaRef({ id: 'a/b', builds: [build] }, build));
    expect(error).toBeInstanceOf(LocalRuntimeError);
  });
});

describe('HuggingFaceHub.getModel', () => {
  it('pins the commit and lists each quant with its size, sha256, resolve URL and Ollama ref', async () => {
    const server = await serve(repoRoutes('Qwen/Qwen2.5-0.5B-Instruct-GGUF', qwenSha, qwenInfo, qwenTree));
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const detail = await hub.getModel('Qwen/Qwen2.5-0.5B-Instruct-GGUF');

    expect(server.requests.map(request => request.path.split('?')[0])).toEqual([
      '/api/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/revision/main',
      `/api/models/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/${qwenSha}`,
    ]);
    expect(query(server.requests[1]?.path ?? '').get('recursive')).toBe('true');
    expect(detail).toMatchObject({
      id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
      revision: qwenSha,
      licenses: ['apache-2.0'],
      licenseName: null,
      licenseLink: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE',
      baseModels: ['Qwen/Qwen2.5-0.5B-Instruct'],
      gguf: { architecture: 'qwen2', contextLength: 8192, parameterCount: 630167424 },
      projectors: [],
      canDownload: true,
    });
    expect(detail.builds.map(build => [build.quant, build.ollamaRef, build.ollamaRefIssue])).toEqual([
      ['Q2_K', 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q2_K', null],
      ['Q4_K_M', 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M', null],
      ['Q8_0', 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q8_0', null],
      [null, null, 'no-quant-label'],
    ]);
    expect(detail.builds[1]).toEqual({
      id: 'qwen2.5-0.5b-instruct-q4_k_m',
      quant: 'Q4_K_M',
      label: 'Q4_K_M',
      files: [
        {
          path: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
          sizeBytes: 491400032,
          sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
          url: `${server.baseUrl}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/${qwenSha}/qwen2.5-0.5b-instruct-q4_k_m.gguf`,
        },
      ],
      sizeBytes: 491400032,
      split: false,
      complete: true,
      ollamaRef: 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M',
      ollamaRefIssue: null,
    });
  });

  it('rejects an answer for a different commit than the one asked for', async () => {
    const server = await serve(repoRoutes('Qwen/Qwen2.5-0.5B-Instruct-GGUF', vlSha, qwenInfo, qwenTree));
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    await expect(hub.getModel('Qwen/Qwen2.5-0.5B-Instruct-GGUF', { revision: vlSha })).rejects.toBeInstanceOf(
      RuntimeProtocolError
    );
  });

  it('pages the tree, groups split and foldered quants, and keeps projectors apart', async () => {
    const repo = 'unsloth/Qwen2.5-VL-72B-Instruct-GGUF';
    const server = await serve({
      [`GET /api/models/${repo}/revision/main`]: json(vlInfo),
      [`GET /api/models/${repo}/tree/${vlSha}`]: (request, response) => {
        const second = query(request.path).get('cursor') === 'page2';
        const link = `<https://huggingface.co/api/models/${repo}/tree/main?recursive=true&cursor=page2>; rel="next"`;
        reply(
          response,
          200,
          { 'content-type': 'application/json', ...(second ? {} : { link }) },
          JSON.stringify(vlTreePages[second ? 1 : 0])
        );
      },
    });
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);

    expect(server.requests.filter(request => request.path.includes('/tree/'))).toHaveLength(2);
    expect(detail).toMatchObject({
      licenses: ['other'],
      licenseName: 'qwen',
      baseModels: ['Qwen/Qwen2.5-VL-72B-Instruct'],
    });
    const byId = Object.fromEntries(detail.builds.map(build => [build.id, build]));
    expect(byId['BF16/Qwen2.5-VL-72B-Instruct-BF16']).toMatchObject({
      quant: 'BF16',
      sizeBytes: 49893814848 + 49938328960 + 45590528544,
      split: true,
      complete: true,
      ollamaRef: null,
      ollamaRefIssue: 'split',
    });
    expect(byId['BF16/Qwen2.5-VL-72B-Instruct-BF16']?.files.map(file => file.path)).toEqual([
      'BF16/Qwen2.5-VL-72B-Instruct-BF16-00001-of-00003.gguf',
      'BF16/Qwen2.5-VL-72B-Instruct-BF16-00002-of-00003.gguf',
      'BF16/Qwen2.5-VL-72B-Instruct-BF16-00003-of-00003.gguf',
    ]);
    expect(byId['Q5_K_M/Qwen2.5-VL-72B-Instruct-Q5_K_M']).toMatchObject({
      quant: 'Q5_K_M',
      sizeBytes: 49941713184 + 4505751872,
      ollamaRefIssue: 'split',
    });
    expect(
      detail.builds.filter(build => !build.split).map(build => [build.quant, build.sizeBytes, build.ollamaRef])
    ).toEqual([
      ['Q2_K', 29811761568, `hf.co/${repo}:Q2_K`],
      ['Q2_K_L', 30103724448, `hf.co/${repo}:Q2_K_L`],
      ['UD-Q4_K_XL', 47321080224, `hf.co/${repo}:UD-Q4_K_XL`],
      ['Q4_K_M', 47415714208, `hf.co/${repo}:Q4_K_M`],
    ]);
    expect(detail.projectors.map(projector => [projector.path, projector.quant, projector.sizeBytes])).toEqual([
      ['mmproj-BF16.gguf', 'BF16', 1410223552],
      ['mmproj-F16.gguf', 'F16', 1410223552],
      ['mmproj-F32.gguf', 'F32', 2815315392],
    ]);
  });

  it('keeps every license a repo declares, from its card and its tags', async () => {
    const repo = 'someone/Mixed-2b-GGUF';
    const sha = 'c'.repeat(40);
    const tags = ['gguf', 'license:apache-2.0', 'license:gemma', 'license:llama3'];
    const info = { id: repo, sha, tags, cardData: { license: ['apache-2.0', 'Gemma', 42] } };
    const server = await serve({
      ...repoRoutes(repo, sha, info, qwenTree),
      'GET /api/models': json([{ id: repo, tags }]),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });

    expect((await hub.getModel(repo)).licenses).toEqual(['apache-2.0', 'gemma', 'llama3']);
    expect((await hub.search({ query: 'mixed' })).models[0]?.licenses).toEqual(['apache-2.0', 'gemma', 'llama3']);
  });

  it('reports other when licenses past the cap are dropped or only a license_name is declared', async () => {
    const permissive = ['mit', 'apache-2.0', 'bsd', 'bsd-2-clause', 'bsd-3-clause', 'isc', '0bsd', 'zlib', 'cc0-1.0'];
    const many = [...permissive, 'unlicense', 'cc-by-nc-4.0'];
    const sha = 'c'.repeat(40);
    const capped = 'someone/Many-GGUF';
    const named = 'someone/Named-GGUF';
    const tags = ['gguf', ...many.map(id => `license:${id}`)];
    const server = await serve({
      ...repoRoutes(capped, sha, { id: capped, sha, cardData: { license: many } }, qwenTree),
      ...repoRoutes(named, sha, { id: named, sha, cardData: { license_name: 'custom-terms' } }, qwenTree),
      'GET /api/models': json([{ id: capped, tags }]),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });

    expect((await hub.getModel(capped)).licenses).toEqual([...permissive, 'other']);
    expect((await hub.search({ query: 'many' })).models[0]?.licenses).toEqual([...permissive, 'other']);
    expect(await hub.getModel(named)).toMatchObject({ licenses: ['other'], licenseName: 'custom-terms' });
  });

  it('flags missing shards and picks a tag no earlier file name ends with', async () => {
    const repo = 'someone/odd-GGUF';
    const sha = 'a'.repeat(40);
    const file = (path: string, size: number) => ({ type: 'file', path, size, lfs: { oid: 'b'.repeat(64), size } });
    const server = await serve(
      repoRoutes(repo, sha, { id: repo, sha }, [
        file('odd-Q8_0-00001-of-00003.gguf', 3),
        file('odd-Q8_0-00003-of-00003.gguf', 3),
        file('odd-Q4_K_M.gguf', 2),
        file('odd-128k-Q4_K_M.gguf', 2),
        file('odd-Q4_K_XL.gguf', 1),
        file('odd-UD-Q4_K_XL.gguf', 1),
        file('odd-Q6_K.gguf', 4),
        file('a/odd-Q2_K.gguf', 1),
        file('b/odd-Q2_K.gguf', 1),
        file('odd-Q5_0-imat.gguf', 5),
        file('vision/odd.mmproj-q8_0.gguf', 5),
        file('../escape-Q5_0.gguf', 7),
        { type: 'file', path: 'odd.imatrix', size: 9 },
      ])
    );
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(detail.builds.map(build => [build.id, build.ollamaRef, build.ollamaRefIssue])).toEqual([
      ['a/odd-Q2_K', `hf.co/${repo}:Q2_K`, null],
      // Same file name in another folder: the registry matches names only, so every tag reaches a/ first.
      ['b/odd-Q2_K', null, 'ambiguous'],
      ['odd-Q4_K_XL', `hf.co/${repo}:Q4_K_XL`, null],
      ['odd-UD-Q4_K_XL', `hf.co/${repo}:UD-Q4_K_XL`, null],
      ['odd-128k-Q4_K_M', `hf.co/${repo}:Q4_K_M`, null],
      ['odd-Q4_K_M', `hf.co/${repo}:odd-Q4_K_M`, null],
      ['odd-Q6_K', `hf.co/${repo}:Q6_K`, null],
      ['odd-Q5_0-imat', `hf.co/${repo}:Q5_0-imat`, null],
      ['odd-Q8_0', null, 'incomplete'],
    ]);
    expect(detail.builds.map(build => build.label)).toEqual([
      'Q2_K',
      'b-odd-Q2_K',
      'Q4_K_XL',
      'UD-Q4_K_XL',
      '128k-Q4_K_M',
      // Q4_K_M is the 128k build's ref tag.
      'odd-Q4_K_M',
      'Q6_K',
      'Q5_0',
      'Q8_0',
    ]);
    expect(detail.builds.at(-1)).toMatchObject({ split: true, complete: false, sizeBytes: 6 });
    expect(detail.projectors.map(projector => [projector.path, projector.quant])).toEqual([
      ['vision/odd.mmproj-q8_0.gguf', 'Q8_0'],
    ]);
    expect(detail).toMatchObject({ licenses: [], gguf: null, gated: false, author: 'someone' });
  });

  it('drops MTP draft heads and imatrix files, so no draft is offered as the quant it is stored in', async () => {
    const repo = 'unsloth/Qwen3.8-Flash-Next-GGUF';
    const server = await serve(repoRoutes(repo, flashNextSha, { id: repo, sha: flashNextSha }, flashNextTree));
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(detail.builds.map(build => [build.id, build.label, build.ollamaRefIssue])).toEqual([
      ['UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL', 'UD-Q4_K_XL', 'split'],
    ]);
    expect(detail.projectors.map(projector => projector.path)).toEqual(['mmproj-BF16.gguf', 'mmproj-F16.gguf']);
  });

  it('drops the draft and imatrix files other publishers name, and keeps models that only resemble them', async () => {
    const repo = 'someone/drafts-GGUF';
    const sha = 'e'.repeat(40);
    const file = (path: string, size: number) => ({ type: 'file', path, size, lfs: { oid: 'f'.repeat(64), size } });
    const server = await serve(
      repoRoutes(repo, sha, { id: repo, sha }, [
        file('gpt-oss-20b-MXFP4.gguf', 12109566624),
        file('eagle3-gpt-oss-20b-Q8_0.gguf', 921488000),
        file('dflash-Qwen3.8-27B-Q4_0.gguf', 1094346080),
        file('dspark-MiniMax-M3.1-Flash-Q8_0.gguf', 2089384768),
        file('mtp-gemma-4-E2B-it.gguf', 97817664),
        file('mtp.gguf', 8),
        file('eagle3.gguf', 9),
        file('draft/mtp/x-Q4_0.gguf', 10),
        file('gemmable-4-12b-Q4_K_M-mtp.gguf', 7),
        // The registry serves a mid-name MTP file when its metadata says it is a model, so the name cannot decide.
        file('Ternary-Bonsai-2-27B-MTP-Q8_0.gguf', 1),
        file('GLM-4.5-Air-MTP-Q4_K_M.gguf', 6),
        file('Qwen_Qwen3.6-35B-A3B-imatrix.gguf', 192223904),
        file('imatrix-qwen3.8-27b.gguf', 2),
        file('imatrix_unsloth.gguf', 463011616),
        file('Llama-3-8B-Q4_K_M-imatrix.gguf', 5),
        file('v5-Eagle-7B-Q4_K_M.gguf', 3),
        file('Smtp-Relay-1B-Q4_0.gguf', 4),
      ])
    );
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(detail.builds.map(build => build.id)).toEqual([
      'Ternary-Bonsai-2-27B-MTP-Q8_0',
      'v5-Eagle-7B-Q4_K_M',
      'Smtp-Relay-1B-Q4_0',
      'Llama-3-8B-Q4_K_M-imatrix',
      'GLM-4.5-Air-MTP-Q4_K_M',
      'gpt-oss-20b-MXFP4',
    ]);
  });

  it('labels builds that share a quant by the part of the file name that sets them apart', async () => {
    const lfm = 'LiquidAI/LFM2.5-350M-GGUF';
    const repo = 'someone/variants-GGUF';
    const sha = 'f'.repeat(40);
    const file = (path: string, size: number) => ({ type: 'file', path, size, lfs: { oid: 'a'.repeat(64), size } });
    const server = await serve({
      ...repoRoutes(lfm, lfmSha, { id: lfm, sha: lfmSha }, lfmTree),
      // File names from unsloth/LTX-2.5-GGUF, unsloth/MiniMax-H3-GGUF and a ggml-org Nemotron repo.
      ...repoRoutes(repo, sha, { id: repo, sha }, [
        file('distilled/ltx-2.5-22b-distilled-Q4_K_M.gguf', 1),
        file('ltx-2.5-22b-dev-Q4_K_M.gguf', 2),
        file('ltx-2.5-22b-dev-Q6_K.gguf', 3),
        file('minimax_h3_fl2va_pruned-Q8_0.gguf', 4),
        file('minimax_h3_ref2va_pruned-Q8_0.gguf', 5),
        file('NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4.gguf', 6),
        file('lilicorr-NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4.gguf', 7),
        file('odd-Q5_0.gguf', 8),
        file('odd-Q5_0-imat.gguf', 9),
      ]),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });

    expect((await hub.getModel(lfm)).builds.map(build => [build.label, build.sizeBytes, build.ollamaRef])).toEqual([
      ['Q4_0', 219309792, `hf.co/${lfm}:Q4_0`],
      ['QAD-Q4_0', 219312832, `hf.co/${lfm}:QAD-Q4_0`],
      ['Q4_K_M', 229312224, `hf.co/${lfm}:Q4_K_M`],
      ['Q5_K_M', 260376288, `hf.co/${lfm}:Q5_K_M`],
      ['Q6_K', 293381856, `hf.co/${lfm}:Q6_K`],
      ['Q8_0', 379217632, `hf.co/${lfm}:Q8_0`],
      ['BF16', 711485152, `hf.co/${lfm}:BF16`],
      ['F16', 711485152, `hf.co/${lfm}:350M-F16`],
    ]);
    expect((await hub.getModel(repo)).builds.map(build => [build.label, build.quant])).toEqual([
      ['distilled-Q4_K_M', 'Q4_K_M'],
      ['dev-Q4_K_M', 'Q4_K_M'],
      ['Q6_K', 'Q6_K'],
      ['fl2va-Q8_0', 'Q8_0'],
      ['ref2va-Q8_0', 'Q8_0'],
      ['NVFP4', 'NVFP4'],
      ['lilicorr-NVFP4', 'NVFP4'],
      ['Q5_0', 'Q5_0'],
      ['Q5_0-imat', 'Q5_0'],
    ]);
  });

  it('keeps every label a tag that resolves to its own build and to no other', async () => {
    const repo = 'someone/clashes-GGUF';
    const sha = 'f'.repeat(40);
    const file = (path: string, size: number) => ({ type: 'file', path, size, lfs: { oid: 'a'.repeat(64), size } });
    const server = await serve(
      repoRoutes(repo, sha, { id: repo, sha }, [
        file('Base-Model-Q4_0.gguf', 1),
        file('Model-Q4_0.gguf', 2),
        file('Lilicorr-Nemotron-NVFP4.gguf', 3),
        file('lilicorr-Nemotron-NVFP4.gguf', 4),
        file('a b/X-Q8_0.gguf', 5),
        file('c d/X-Q8_0.gguf', 6),
      ])
    );
    const { builds } = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(builds.map(build => [build.label, build.ollamaRef?.split(':')[1] ?? null])).toEqual([
      ['Base-Q4_0', 'Q4_0'],
      ['Model-Q4_0', null],
      ['NVFP4', 'NVFP4'],
      ['lilicorr-Nemotron-NVFP4-2', null],
      ['Q8_0', 'Q8_0'],
      ['c-d-X-Q8_0', null],
    ]);
    for (const build of builds) {
      expect(hubBuildTag(build)).toMatch(/^[A-Za-z0-9_.-]+$/);
      expect(findHubBuild(builds, hubBuildTag(build))).toBe(build);
      expect(findHubBuild(builds, build.label.toLowerCase())).toBe(build);
    }
  });

  it('keeps labels Ollama-sized tags even for names with no tag characters, long folders and suffix clashes', async () => {
    const repo = 'someone/odd-names-GGUF';
    const sha = 'f'.repeat(40);
    const file = (path: string, size: number) => ({ type: 'file', path, size, lfs: { oid: 'a'.repeat(64), size } });
    const server = await serve(
      repoRoutes(repo, sha, { id: repo, sha }, [
        file('模型.gguf', 1),
        file('型.gguf', 2),
        file(`${'a'.repeat(60)}/${'b'.repeat(60)}-Q4_0.gguf`, 3),
        file(`${'c'.repeat(70)}/${'b'.repeat(60)}-Q4_0.gguf`, 4),
        file('M-Q8_0.gguf', 5),
        file('m-Q8_0.gguf', 6),
        file('m-Q8_0-2.gguf', 7),
      ])
    );
    const { builds } = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(builds.map(build => build.label)).toEqual([
      'build',
      'build-2',
      'Q4_0',
      `${'c'.repeat(70)}-${'b'.repeat(9)}`,
      'Q8_0',
      'm-Q8_0-3',
      'Q8_0-2',
    ]);
    for (const build of builds) {
      expect(build.label).toMatch(/^[A-Za-z0-9_][\w.-]{0,79}$/);
      expect(findHubBuild(builds, hubBuildTag(build))).toBe(build);
    }
    // Ollama serves m-Q8_0-2.gguf for this tag, so it must not name the m-Q8_0 build.
    expect(findHubBuild(builds, 'm-Q8_0-2')).toBeUndefined();
  });

  it('resolves a quant alone only when a single build has it', async () => {
    const repo = 'someone/split-pair-GGUF';
    const sha = 'f'.repeat(40);
    const file = (path: string, size: number) => ({ type: 'file', path, size, lfs: { oid: 'a'.repeat(64), size } });
    const server = await serve(
      repoRoutes(repo, sha, { id: repo, sha }, [
        file('a-Q4_0-00001-of-00002.gguf', 5),
        file('a-Q4_0-00002-of-00002.gguf', 5),
        file('b-Q4_0-00001-of-00002.gguf', 2),
        file('b-Q4_0-00002-of-00002.gguf', 2),
        file('b-Q8_0-00001-of-00002.gguf', 2),
        file('b-Q8_0-00002-of-00002.gguf', 2),
      ])
    );
    const { builds } = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(builds.map(build => [build.label, build.ollamaRef])).toEqual([
      ['b-Q4_0', null],
      ['Q8_0', null],
      ['a-Q4_0', null],
    ]);
    expect(findHubBuild(builds, 'Q4_0')).toBeUndefined();
    expect(findHubBuild(builds, 'q8_0')?.id).toBe('b-Q8_0');
  });

  it('labels bartowski _L builds and blocks only the ones the registry rejects as tags', async () => {
    const repo = 'bartowski/Llama-3.2-1B-Instruct-GGUF';
    const sha = 'c'.repeat(40);
    const file = (path: string, size: number) => ({ type: 'file', path, size, lfs: { oid: 'd'.repeat(64), size } });
    const server = await serve(
      repoRoutes(repo, sha, { id: repo, sha }, [
        file('Llama-3.2-1B-Instruct-Q3_K_XL.gguf', 796139648),
        file('Llama-3.2-1B-Instruct-Q4_K_L.gguf', 871309440),
        file('Llama-3.2-1B-Instruct-Q4_K_M.gguf', 807694464),
        file('Llama-3.2-1B-Instruct-Q5_K_L.gguf', 975118464),
        file('Llama-3.2-1B-Instruct-Q6_K.gguf', 1021800576),
        file('Llama-3.2-1B-Instruct-Q6_K_L.gguf', 1085415552),
        file('Llama-3.2-1B-Instruct-IQ4_XS.gguf', 743000000),
        file('Model-UD-Q4_K_L.gguf', 1),
        file('Model-Q8_K_L.gguf', 2),
        file('Model-F16-Q4_K_L.gguf', 3),
        file('Model-Q5_K_L_IMAT.gguf', 4),
      ])
    );
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(detail.builds.map(build => [build.quant, build.ollamaRef, build.ollamaRefIssue])).toEqual([
      ['UD-Q4_K_L', null, 'unsupported-quant'],
      ['Q8_K_L', null, 'unsupported-quant'],
      // Another scheme in the name still gives the registry a tag it accepts.
      ['Q4_K_L', `hf.co/${repo}:F16-Q4_K_L`, null],
      ['Q5_K_L_IMAT', null, 'unsupported-quant'],
      ['IQ4_XS', `hf.co/${repo}:IQ4_XS`, null],
      ['Q3_K_XL', `hf.co/${repo}:Q3_K_XL`, null],
      ['Q4_K_M', `hf.co/${repo}:Q4_K_M`, null],
      ['Q4_K_L', null, 'unsupported-quant'],
      ['Q5_K_L', null, 'unsupported-quant'],
      ['Q6_K', `hf.co/${repo}:Q6_K`, null],
      ['Q6_K_L', `hf.co/${repo}:Q6_K_L`, null],
    ]);
  });

  it('follows a same-origin redirect for a renamed repo and uses the new id', async () => {
    const server = await serve({
      'GET /api/models/old/name-GGUF/revision/main': (request, response) =>
        reply(response, 307, { location: request.path.replace('old/name-GGUF', 'Qwen/Qwen2.5-0.5B-Instruct-GGUF') }),
      ...repoRoutes('Qwen/Qwen2.5-0.5B-Instruct-GGUF', qwenSha, qwenInfo, qwenTree),
    });
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN }).getModel('old/name-GGUF');
    expect(detail.id).toBe('Qwen/Qwen2.5-0.5B-Instruct-GGUF');
    expect(detail.builds[0]?.ollamaRef).toBe('hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q2_K');
    expect(server.requests.every(request => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('refuses a redirect to another origin without sending it the token', async () => {
    const elsewhere = await serve({});
    const server = await serve({
      'GET /api/models/a/b/revision/main': (_request, response) =>
        reply(response, 302, { location: `${elsewhere.baseUrl}/steal` }),
    });
    const error = await caught(new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN }).getModel('a/b'));
    expect(error).toBeInstanceOf(RuntimeProtocolError);
    expect(elsewhere.requests).toEqual([]);
  });
});

describe('HuggingFaceHub Ollama refs', () => {
  const lfsFile = (path: string, size: number, oid: string) => ({ type: 'file', path, size, lfs: { oid, size } });
  const BF16_OID = 'f5d05e90d179fa27c01a049be1574a0201bdc09ba0b345eb85e1dbf3b87610f3';
  const F16_OID = '7e2a46fe01895b16776ed927aac8f56c5661a06d47c8a6f87ec297c805fbe3c2';
  const Q4_OID = '3f5a22426976ab26cfe84dba63c1d08391717abb1af893e10f1b2968d862dcc1';
  const llama = 'unsloth/Llama-3.2-1B-Instruct-GGUF';
  const llamaSha = 'b69aef112e9f895e6f98d7ae0949f72ff09aa401';
  const llamaTree = [
    lfsFile('Llama-3.2-1B-Instruct-BF16.gguf', 2479595264, BF16_OID),
    lfsFile('Llama-3.2-1B-Instruct-F16.gguf', 2479595168, F16_OID),
    lfsFile('Llama-3.2-1B-Instruct-Q4_K_M.gguf', 807694368, Q4_OID),
  ];
  const manifest = (oid: string) =>
    json({
      schemaVersion: 2,
      layers: [
        { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${oid}`, size: 1 },
        { mediaType: 'application/vnd.ollama.image.template', digest: `sha256:${'0'.repeat(64)}`, size: 1 },
      ],
    });

  it('does not hand out :F16 when the registry resolves that tag to the earlier BF16 file', async () => {
    // Live, /v2/<this repo>/manifests/F16 answers with the BF16 blob and Instruct-F16 with the F16 one.
    const server = await serve(repoRoutes(llama, llamaSha, { id: llama, sha: llamaSha }, llamaTree));
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(llama);
    const f16 = detail.builds.find(build => build.quant === 'F16');
    expect(f16?.files[0]?.sha256).toBe(F16_OID);
    expect(f16?.ollamaRef).not.toBe(`hf.co/${llama}:F16`);
    expect(f16?.ollamaRef).toBe(`hf.co/${llama}:Instruct-F16`);
    expect(detail.builds.find(build => build.quant === 'BF16')?.ollamaRef).toBe(`hf.co/${llama}:BF16`);
  });

  it('keeps HubGgufBuild.id unique when a merged file sits next to its shards', async () => {
    const repo = 'someone/model-GGUF';
    const sha = 'd'.repeat(40);
    const server = await serve(
      repoRoutes(repo, sha, { id: repo, sha }, [
        lfsFile('model-Q8_0.gguf', 30, 'e'.repeat(64)),
        lfsFile('model-Q8_0-00001-of-00002.gguf', 15, 'f'.repeat(64)),
        lfsFile('model-Q8_0-00002-of-00002.gguf', 15, '1'.repeat(64)),
      ])
    );
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    const ids = detail.builds.map(build => build.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(detail.builds.map(build => [build.id, build.ollamaRefIssue])).toEqual([
      // The first shard sorts first, so every tag that matches the merged file reaches the shard.
      ['model-Q8_0', 'ambiguous'],
      ['model-Q8_0-00001-of-00002', 'split'],
    ]);
  });

  it('gives no ref for a revision other than main, or a repo id Ollama cannot name', async () => {
    const server = await serve({
      ...repoRoutes(llama, llamaSha, { id: llama, sha: llamaSha }, llamaTree),
      ...repoRoutes('org.name/model-GGUF', llamaSha, { id: 'org.name/model-GGUF', sha: llamaSha }, llamaTree),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const pinned = await hub.getModel(llama, { revision: llamaSha });
    expect(pinned.builds.map(build => [build.ollamaRef, build.ollamaRefIssue])).toEqual([
      [null, 'pinned-revision'],
      [null, 'pinned-revision'],
      [null, 'pinned-revision'],
    ]);
    const dotted = await hub.getModel('org.name/model-GGUF');
    expect(new Set(dotted.builds.map(build => build.ollamaRefIssue))).toEqual(new Set(['unsupported-name']));
  });

  it('verifies a ref against the registry manifest before a pull', async () => {
    const server = await serve({
      ...repoRoutes(llama, llamaSha, { id: llama, sha: llamaSha }, llamaTree),
      [`GET /v2/${llama}/manifests/Instruct-F16`]: manifest(F16_OID),
      [`GET /v2/${llama}/manifests/BF16`]: manifest(BF16_OID),
      [`GET /v2/${llama}/manifests/Q4_K_M`]: json({ error: 'The requested GGUF file is not available' }, 400),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN });
    const detail = await hub.getModel(llama);
    const byQuant = (quant: string) => detail.builds.find(build => build.quant === quant)!;
    expect(await hub.verifyOllamaRef(detail, byQuant('F16'))).toBe(`hf.co/${llama}:Instruct-F16`);
    expect(await hub.verifyOllamaRef(detail, byQuant('BF16'))).toBe(`hf.co/${llama}:BF16`);
    expect(await hub.verifyOllamaRef(detail, byQuant('Q4_K_M'))).toBeNull();
    const manifestRequest = server.requests.find(request => request.path.startsWith('/v2/'));
    expect(manifestRequest?.headers).toMatchObject({
      accept: 'application/vnd.docker.distribution.manifest.v2+json',
      authorization: `Bearer ${TOKEN}`,
    });

    // A pinned build verifies when main still serves the same bytes, and a different file under the tag does not.
    const pinned = await hub.getModel(llama, { revision: llamaSha });
    const f16 = pinned.builds.find(build => build.quant === 'F16')!;
    expect(f16.ollamaRefIssue).toBe('pinned-revision');
    expect(await hub.verifyOllamaRef(pinned, f16)).toBe(`hf.co/${llama}:Instruct-F16`);
    const changed = { ...f16, files: [{ ...f16.files[0]!, sha256: Q4_OID }] };
    expect(await hub.verifyOllamaRef(pinned, changed)).toBeNull();
  });

  it('skips the request for builds no tag can pull and maps registry access errors', async () => {
    const server = await serve({
      ...repoRoutes(llama, llamaSha, { id: llama, sha: llamaSha }, llamaTree),
      [`GET /v2/${llama}/manifests/BF16`]: (_request, response) =>
        reply(response, 401, { 'x-error-code': 'GatedRepo', 'x-error-message': gatedMessage }),
      [`GET /v2/${llama}/manifests/Q4_K_M`]: json({ error: 'Invalid username or password.' }, 401),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const detail = await hub.getModel(llama);
    const byQuant = (quant: string) => detail.builds.find(build => build.quant === quant)!;
    const before = server.requests.length;
    expect(await hub.verifyOllamaRef(detail, { ...byQuant('F16'), split: true })).toBeNull();
    const unhashed = { ...byQuant('F16'), files: [{ ...byQuant('F16').files[0]!, sha256: null }] };
    expect(await hub.verifyOllamaRef(detail, unhashed)).toBeNull();
    expect(server.requests.length).toBe(before);
    expect(await caught(hub.verifyOllamaRef(detail, byQuant('BF16')))).toMatchObject({
      name: 'HubAccessError',
      reason: 'gated',
    });
    expect(await caught(hub.verifyOllamaRef(detail, byQuant('Q4_K_M')))).toBeInstanceOf(ModelNotFoundError);
  });

  const sha = 'c'.repeat(40);
  const oid = (n: number) => n.toString(16).padStart(64, '0');
  const numbered = (path: string, n: number) => lfsFile(path, 1, oid(n));
  const simpleRoutes = (repo: string, tree: unknown): Record<string, Handler> =>
    repoRoutes(repo, sha, { id: repo, sha }, tree);

  /** The registry rule, plus the skipping of drafts the file list cannot tell apart, modeled as a `head-` prefix. */
  const registry =
    (tree: { path: string; lfs: { oid: string } }[]): Handler =>
    (request, response) => {
      const tag = decodeURIComponent(request.path.split('/manifests/')[1] ?? '').toUpperCase();
      const hit = [...tree]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .find(entry => {
          const name = entry.path.replace(/^.*\//, '');
          const stem = name.replace(/\.gguf$/i, '').toUpperCase();
          return !/mmproj/i.test(name) && !/^head-/i.test(name) && stem.endsWith(tag);
        });
      return (hit ? manifest(hit.lfs.oid) : json({ error: 'The specified tag is not available' }, 400))(
        request,
        response
      );
    };

  it('starts a tag after a character Ollama tags do not allow, such as a space', async () => {
    // Live, hf.co/<a repo>:Q8_0 pulls "Gemma3-270M Q8_0.gguf" through Ollama 0.40.11.
    const repo = 'someone/spaced-GGUF';
    const tree = [numbered('Gemma3-270M Q8_0.gguf', 1), numbered('SmolLM2-135m Q8_0.gguf', 2)];
    const server = await serve({ ...simpleRoutes(repo, tree), [`GET /v2/${repo}/manifests/Q8_0`]: registry(tree) });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const detail = await hub.getModel(repo);
    const gemma = detail.builds.find(build => build.id === 'Gemma3-270M Q8_0');
    expect(gemma).toMatchObject({ ollamaRef: `hf.co/${repo}:Q8_0`, ollamaRefIssue: null });
    expect(gemma && (await hub.verifyOllamaRef(detail, gemma))).toBe(`hf.co/${repo}:Q8_0`);
    expect(detail.builds.find(build => build.id === 'SmolLM2-135m Q8_0')?.ollamaRefIssue).toBe('ambiguous');
  });

  it('plans Ollama tags in near-linear time as the repo grows', async () => {
    // Each odd file's tails are all blocked by the even file just before it.
    const plan = async (files: number) => {
      const repo = `someone/many-${files}-GGUF`;
      const tree = Array.from({ length: files }, (_, i) => {
        const pair = `${Array.from({ length: 12 }, () => `p${i >> 1}`).join('-')}-Q4_K_M`;
        return numbered(`v${String(i).padStart(5, '0')}/${i % 2 ? pair : `y-${pair}`}.gguf`, i + 1);
      });
      const server = await serve(simpleRoutes(repo, tree));
      const hub = new HuggingFaceHub({ endpoint: server.baseUrl, requestTimeoutMs: 120_000 });
      const started = performance.now();
      const detail = await hub.getModel(repo);
      const elapsed = performance.now() - started;
      expect(detail.builds.filter(build => build.ollamaRefIssue === 'ambiguous')).toHaveLength(files / 2);
      return elapsed;
    };
    await plan(500);
    // 8x the files costs about 8x linear and 64x quadratic; best of three damps CI noise.
    const small = Math.min(await plan(1000), await plan(1000), await plan(1000));
    const large = Math.min(await plan(8000), await plan(8000));
    expect(large / small).toBeLessThan(32);
  }, 180_000);

  it('answers null for a 404 manifest', async () => {
    const repo = 'someone/model-GGUF';
    const tree = [numbered('model-Q4_K_M.gguf', 1)];
    const server = await serve({
      ...simpleRoutes(repo, tree),
      [`GET /v2/${repo}/manifests/Q4_K_M`]: json({ error: 'not found' }, 404),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const detail = await hub.getModel(repo);
    expect(detail.builds[0] && (await hub.verifyOllamaRef(detail, detail.builds[0]))).toBeNull();
  });

  it('tries the next tag when a skipped draft blocks the first, up to MAX_VERIFY_TAGS requests', async () => {
    const repo = 'someone/drafty-GGUF';
    const tree = [
      numbered('Heads/head-m-BF16.gguf', 1),
      numbered('Heads/head-m-F16.gguf', 2),
      numbered('m-BF16.gguf', 3),
      numbered('m-F16.gguf', 4),
      numbered('Heads/head-a-b-c-d-e-Q8_0.gguf', 5),
      numbered('a-b-c-d-e-Q8_0.gguf', 6),
    ];
    const tags = ['F16', 'm-F16', 'Q8_0', 'e-Q8_0', 'd-e-Q8_0', 'c-d-e-Q8_0', 'b-c-d-e-Q8_0'];
    const server = await serve({
      ...simpleRoutes(repo, tree),
      ...Object.fromEntries(tags.map(tag => [`GET /v2/${repo}/manifests/${tag}`, registry(tree)])),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    const detail = await hub.getModel(repo);
    const f16 = detail.builds.find(build => build.id === 'm-F16');
    expect(f16?.ollamaRefIssue).toBe('ambiguous');
    // :F16 reaches m-BF16.gguf; :m-F16 reaches m-F16.gguf because the draft is skipped.
    expect(f16 && (await hub.verifyOllamaRef(detail, f16))).toBe(`hf.co/${repo}:m-F16`);

    // Every tail of the skipped draft reaches the main file instead, so no tag pulls the draft.
    const draft = detail.builds.find(build => build.id === 'Heads/head-a-b-c-d-e-Q8_0');
    const before = server.requests.length;
    expect(draft && (await hub.verifyOllamaRef(detail, draft))).toBeNull();
    expect(server.requests.slice(before).map(request => request.path.split('/').at(-1))).toEqual(
      tags.slice(2, 2 + MAX_VERIFY_TAGS)
    );
  });

  it('flags gated and private repos, whose Ollama pull needs the Ollama SSH key on the account', async () => {
    const server = await serve({
      ...repoRoutes(llama, llamaSha, { id: llama, sha: llamaSha }, llamaTree),
      ...simpleRoutes('a/private-GGUF', llamaTree),
      'GET /api/models/a/private-GGUF/revision/main': json({ id: 'a/private-GGUF', sha, private: true }),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN });
    expect((await hub.getModel(llama)).ollamaNeedsSshKey).toBe(false);
    expect((await hub.getModel('a/private-GGUF')).ollamaNeedsSshKey).toBe(true);
  });
});

describe('HuggingFaceHub gated repos', () => {
  const repo = 'google/gemma-3-1b-it-qat-q4_0-gguf';
  const headPath = `HEAD /${repo}/resolve/${gatedSha}/gemma-3-1b-it-q4_0.gguf`;

  it('reports a gated repo as not downloadable without a token, and does not probe it', async () => {
    const server = await serve(repoRoutes(repo, gatedSha, gatedInfo, gatedTree));
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo);
    expect(detail).toMatchObject({ gated: 'manual', canDownload: false, licenses: ['gemma'], ollamaNeedsSshKey: true });
    expect(detail.builds).toEqual([
      expect.objectContaining({
        quant: 'Q4_0',
        sizeBytes: 1003541152,
        files: [expect.objectContaining({ sha256: null })],
        ollamaRef: `hf.co/${repo}:Q4_0`,
      }),
    ]);
    expect(server.requests.map(request => request.method)).toEqual(['GET', 'GET']);
  });

  it('reports no access when the token holder has not been approved', async () => {
    const server = await serve({
      ...repoRoutes(repo, gatedSha, gatedInfo, gatedTree),
      [headPath]: (_request, response) =>
        reply(response, 403, { 'x-error-code': 'GatedRepo', 'x-error-message': gatedMessage }),
    });
    const detail = await new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN }).getModel(repo);
    expect(detail.canDownload).toBe(false);
    const head = server.requests.find(request => request.method === 'HEAD');
    expect(head?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reports access from a resolve redirect without following it', async () => {
    const cdn = await serve({});
    const server = await serve({
      ...repoRoutes(repo, gatedSha, gatedInfo, gatedTree),
      [headPath]: (_request, response) => reply(response, 302, { location: `${cdn.baseUrl}/blob` }),
    });
    const detail: HubModelDetail = await new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN }).getModel(repo);
    expect(detail.canDownload).toBe(true);
    expect(cdn.requests).toEqual([]);
  });

  it('maps a gated 401 on a file to HubAccessError', async () => {
    const server = await serve({
      [`GET /api/models/${repo}/revision/main`]: (_request, response) =>
        reply(
          response,
          401,
          { 'content-type': 'text/plain', 'x-error-code': 'GatedRepo', 'x-error-message': gatedMessage },
          'denied'
        ),
    });
    const error = await caught(new HuggingFaceHub({ endpoint: server.baseUrl }).getModel(repo));
    expect(error).toBeInstanceOf(HubAccessError);
    expect(error).toMatchObject({ status: 401, reason: 'gated', repo });
  });
});

describe('HuggingFaceHub errors', () => {
  const infoPath = 'GET /api/models/a/b/revision/main';

  it('maps an anonymous 401 to ModelNotFoundError, since the Hub hides private repos that way', async () => {
    const server = await serve({ [infoPath]: json({ error: 'Invalid username or password.' }, 401) });
    const error = await caught(new HuggingFaceHub({ endpoint: server.baseUrl }).getModel('a/b'));
    expect(error).toBeInstanceOf(ModelNotFoundError);
    expect(error).toMatchObject({ model: 'a/b', runtimeId: 'huggingface:' + server.baseUrl.slice(7) });
  });

  it('maps a bare 401 with a token to ModelNotFoundError and a 403 to HubAccessError', async () => {
    const server = await serve({
      [infoPath]: json({ error: 'Invalid username or password.' }, 401),
      'GET /api/models/a/c/revision/main': json({ error: 'Invalid credentials in Authorization header' }, 403),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN });
    expect(await caught(hub.getModel('a/b'))).toMatchObject({ name: 'ModelNotFoundError', model: 'a/b' });
    const error = await caught(hub.getModel('a/c'));
    expect(error).toBeInstanceOf(HubAccessError);
    expect(error).toMatchObject({ status: 403, reason: 'unauthorized', repo: 'a/c' });
  });

  it('maps a missing revision and a missing repo to ModelNotFoundError', async () => {
    const server = await serve({
      'GET /api/models/a/b/revision/nope': (_request, response) =>
        reply(response, 404, { 'x-error-code': 'RevisionNotFound', 'x-error-message': 'Invalid rev id: nope' }),
      'GET /api/models/a/c/revision/main': json({ error: 'Repository not found' }, 404),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN });
    expect(await caught(hub.getModel('a/b', { revision: 'nope' }))).toMatchObject({
      name: 'ModelNotFoundError',
      model: 'a/b@nope',
    });
    expect(await caught(hub.getModel('a/c'))).toMatchObject({ name: 'ModelNotFoundError', model: 'a/c' });
  });

  it('maps 429 to HubRateLimitError with Retry-After or the RateLimit reset', async () => {
    const server = await serve({
      'GET /api/models': withHeaders({ error: 'Too many requests' }, { 'retry-after': '30' }, 429),
      [infoPath]: withHeaders({ error: 'slow down' }, { ratelimit: '"api";r=0;t=53' }, 429),
      'GET /api/models/a/c/revision/main': json({ error: 'slow down' }, 429),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl, maxRateLimitWaitMs: 0 });
    const search = await caught(hub.search());
    expect(search).toBeInstanceOf(HubRateLimitError);
    expect(search).toBeInstanceOf(RuntimeHttpError);
    expect(search).toMatchObject({ status: 429, retryAfterMs: 30_000 });
    expect(search.message).toContain('Too many requests');
    expect(await caught(hub.getModel('a/b'))).toMatchObject({ retryAfterMs: 53_000 });
    expect(await caught(hub.getModel('a/c'))).toMatchObject({ retryAfterMs: null });
  });

  it('rejects malformed JSON and unexpected shapes with RuntimeProtocolError', async () => {
    const server = await serve({
      'GET /api/models': json('{"oops":'),
      [infoPath]: json({ id: 'a/b', sha: 'not-a-sha' }),
    });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    expect(await caught(hub.search())).toBeInstanceOf(RuntimeProtocolError);
    expect(await caught(hub.getModel('a/b'))).toBeInstanceOf(RuntimeProtocolError);
  });

  it('rejects a body over the size bound', async () => {
    const server = await serve({
      'GET /api/models': (_request, response) =>
        reply(response, 200, { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) }),
    });
    expect(await caught(new HuggingFaceHub({ endpoint: server.baseUrl }).search())).toBeInstanceOf(
      RuntimeProtocolError
    );
  });

  it.each([
    ['malformed JSON', TOKEN],
    ['unexpected JSON shape', JSON.stringify({ [TOKEN]: TOKEN })],
  ])('keeps echoed credentials out of %s errors and their causes', async (_label, body) => {
    const hub = new HuggingFaceHub({ token: TOKEN, fetch: async () => new Response(body) });
    const error = await caught(hub.search());

    expect(error).toBeInstanceOf(RuntimeProtocolError);
    expectNoToken(error);
    expect(inspect(error, { depth: 10 })).not.toContain(TOKEN.slice(0, 10));
  });

  it('never puts the token in an error, even when the server echoes it', async () => {
    const echo: Handler = (request, response) =>
      reply(
        response,
        Number(query(request.path).get('status') ?? 500),
        {
          'content-type': 'application/json',
          'x-error-message': `bad header ${request.headers.authorization ?? ''}`,
        },
        JSON.stringify({ error: `got ${request.headers.authorization ?? ''}` })
      );
    const server = await serve({ 'GET /api/models': echo, [infoPath]: echo });
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl, token: TOKEN });
    for (const error of [await caught(hub.search()), await caught(hub.getModel('a/b'))]) {
      expect(error).toBeInstanceOf(RuntimeHttpError);
      expect(error.message).toContain('[redacted]');
      expectNoToken(error);
    }
    const refused = await caught(
      new HuggingFaceHub({ endpoint: `http://127.0.0.1:${await closedPort()}`, token: TOKEN }).search()
    );
    expect(refused).toBeInstanceOf(RuntimeConnectionError);
    expectNoToken(refused);
    const thrown = await caught(
      new HuggingFaceHub({
        token: TOKEN,
        fetch: async (_url, init) => {
          throw new Error(`proxy said ${JSON.stringify(init?.headers)}`);
        },
      }).search()
    );
    expect(thrown).toBeInstanceOf(RuntimeConnectionError);
    expectNoToken(thrown);
    expect(inspect(hub, { depth: 10, showHidden: true })).not.toContain(TOKEN);
  });

  it('keeps the token out of a nested fetch cause', async () => {
    const thrown = await caught(
      new HuggingFaceHub({
        token: TOKEN,
        fetch: async (_url, init) => {
          const inner = Object.assign(new Error(`socket said Bearer ${TOKEN}`), { code: 'ECONNRESET' });
          throw new TypeError('fetch failed', {
            cause: new Error(`headers ${JSON.stringify(init?.headers)}`, { cause: inner }),
          });
        },
      }).search()
    );
    expect(thrown).toBeInstanceOf(RuntimeConnectionError);
    expectNoToken(thrown);
    const cause = thrown.cause as Error;
    expect(cause).toMatchObject({ name: 'TypeError', message: 'fetch failed' });
    expect((cause.cause as Error).cause).toMatchObject({ code: 'ECONNRESET' });
  });

  it('rejects a token fetch would refuse as a header value without echoing it', () => {
    const secret = 'hf_FirstHalfOfSecret\nSecondHalfOfSecret';
    let error: unknown;
    try {
      new HuggingFaceHub({ endpoint: 'http://127.0.0.1:9', token: secret });
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeInstanceOf(LocalRuntimeError);
    expectNoToken(error as Error, 'SecondHalfOfSecret');
    expectNoToken(error as Error, 'FirstHalfOfSecret');
  });

  it('times out with RuntimeConnectionError and passes a caller abort through', async () => {
    const server = await serve({ 'GET /api/models': hang });
    const timedOut = await caught(new HuggingFaceHub({ endpoint: server.baseUrl, requestTimeoutMs: 50 }).search());
    expect(timedOut).toBeInstanceOf(RuntimeConnectionError);
    expect(timedOut.message).toContain('timed out after 50ms');

    const controller = new AbortController();
    const pending = new HuggingFaceHub({ endpoint: server.baseUrl }).search({ signal: controller.signal });
    controller.abort();
    expect(await caught(pending)).toMatchObject({ name: 'AbortError' });
  });

  it('rejects an invalid repo id or revision before any request', async () => {
    const server = await serve({});
    const hub = new HuggingFaceHub({ endpoint: server.baseUrl });
    await expect(hub.getModel('gpt2')).rejects.toBeInstanceOf(LocalRuntimeError);
    await expect(hub.getModel('a/b', { revision: '../x' })).rejects.toBeInstanceOf(LocalRuntimeError);
    expect(server.requests).toEqual([]);
  });
});
