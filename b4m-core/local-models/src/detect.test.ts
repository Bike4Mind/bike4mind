import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROBE_HOSTS, detectRuntimes } from './detect';
import type { FetchLike } from './types';
import { hang, json, startFakeServer, type FakeServer, type Handler } from './__test__/fakeServer';

const servers: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function serve(routes: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(routes);
  servers.push(server);
  return server;
}

/** The error Node's fetch throws when nothing listens on the port. */
function connectionRefused(): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  });
}

/**
 * Sends each default port to a fake, or refuses it, so no test touches a real local runtime. The
 * refusal is synthetic: forwarding to a released port races the fakes, which can be handed that port.
 */
function routedFetch(targets: Record<string, FakeServer>): FetchLike {
  return (url, init) => {
    const match = /^http:\/\/127\.0\.0\.1:(\d+)(\/.*)$/.exec(url);
    if (!match) return fetch(url, init);
    const [, port, path] = match;
    const target = targets[port ?? ''];
    if (target) return fetch(`http://127.0.0.1:${target.port}${path}`, init);
    if (DEFAULT_PROBE_HOSTS.includes(`127.0.0.1:${port}`)) return Promise.reject(connectionRefused());
    return fetch(url, init);
  };
}

const ollamaRoutes = {
  'GET /api/version': json({ version: '0.31.1' }),
  'GET /v1/models': json({ object: 'list', data: [{ id: 'qwen3:8b', object: 'model', owned_by: 'library' }] }),
};

const llamaServerRoutes = {
  'GET /v1/models': json({ object: 'list', data: [{ id: 'model.gguf', object: 'model', owned_by: 'llamacpp' }] }),
};

describe('detectRuntimes', () => {
  it('finds an Ollama on a non-default configured port by its /api/version answer', async () => {
    const ollama = await serve(ollamaRoutes);
    const found = await detectRuntimes({ hosts: [`127.0.0.1:${ollama.port}`], fetch: routedFetch({}) });

    expect(found).toHaveLength(1);
    expect(found[0]?.runtime.kind).toBe('ollama');
    expect(found[0]?.runtime.id).toBe(`ollama:127.0.0.1:${ollama.port}`);
    expect(found[0]?.runtime.baseUrl).toBe(ollama.baseUrl);
    expect(found[0]?.health).toEqual({ ok: true, version: '0.31.1', error: null });
    expect(found[0]?.configured).toBe(true);
    expect(found[0]?.product).toBeNull();
  });

  it('does not mistake an OpenAI-compatible server on 11434 for Ollama', async () => {
    const llama = await serve(llamaServerRoutes);
    const found = await detectRuntimes({ fetch: routedFetch({ '11434': llama }) });

    expect(found).toHaveLength(1);
    expect(found[0]?.runtime.kind).toBe('openai-compatible');
    expect(found[0]?.runtime.baseUrl).toBe('http://127.0.0.1:11434');
    expect(found[0]?.runtime.id).toBe('openai-compatible:127.0.0.1:11434');
    expect(found[0]?.product).toBe('llama-server');
    expect(found[0]?.configured).toBe(false);
  });

  it('identifies LM Studio by its native endpoint and vLLM by owned_by', async () => {
    const lmStudio = await serve({
      'GET /v1/models': json({ object: 'list', data: [{ id: 'm', object: 'model', owned_by: 'organization_owner' }] }),
      'GET /api/v0/models': json({
        object: 'list',
        data: [{ id: 'm', object: 'model', type: 'llm', arch: 'llama', quantization: 'Q4_K_M', state: 'loaded' }],
      }),
    });
    const vllm = await serve({
      'GET /v1/models': json({ object: 'list', data: [{ id: 'Qwen/Qwen3-8B', object: 'model', owned_by: 'vllm' }] }),
    });
    const ollama = await serve(ollamaRoutes);
    const found = await detectRuntimes({ fetch: routedFetch({ '11434': ollama, '1234': lmStudio, '8000': vllm }) });

    expect(found.map(entry => [entry.runtime.id, entry.product])).toEqual([
      ['ollama', null],
      ['openai-compatible:127.0.0.1:1234', 'lmstudio'],
      ['openai-compatible:127.0.0.1:8000', 'vllm'],
    ]);
  });

  it('reports an unidentified OpenAI-compatible server with a null product', async () => {
    const generic = await serve({ 'GET /v1/models': json({ data: [] }) });
    const found = await detectRuntimes({ hosts: [generic.baseUrl], defaultHosts: [], fetch: routedFetch({}) });
    expect(found.map(entry => [entry.runtime.kind, entry.product])).toEqual([['openai-compatible', null]]);
  });

  it('probes configured hosts first, de-duplicates them against the defaults and omits silent hosts', async () => {
    const ollama = await serve(ollamaRoutes);
    const slow = await serve({ 'GET /api/version': hang, 'GET /v1/models': hang });
    const found = await detectRuntimes({
      hosts: [`http://127.0.0.1:${slow.port}`, '127.0.0.1:11434', 'not a host'],
      fetch: routedFetch({ '11434': ollama }),
      timeoutMs: 100,
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.runtime.id).toBe('ollama');
    expect(found[0]?.configured).toBe(true);
  });

  it('dedupes localhost against the default 127.0.0.1 probe', async () => {
    const ollama = await serve(ollamaRoutes);
    const found = await detectRuntimes({ hosts: ['localhost:11434'], fetch: routedFetch({ '11434': ollama }) });
    expect(found).toHaveLength(1);
    expect(found[0]?.runtime.id).toBe('ollama');
    expect(found[0]?.configured).toBe(true);
  });

  it.each([401, 403])('counts a FastAPI-style %i on a default port as a keyed runtime', async status => {
    const guarded = await serve({ 'GET /v1/models': json({ detail: 'Invalid API key' }, status) });
    const found = await detectRuntimes({
      defaultHosts: [guarded.baseUrl],
      fetch: routedFetch({}),
    });
    expect(found.map(entry => [entry.runtime.kind, entry.configured, entry.health])).toEqual([
      ['openai-compatible', false, { ok: false, version: null, error: 'Requires an API key' }],
    ]);
  });

  it.each([undefined, null, 0, false, {}, [{ msg: 'x' }]])(
    'ignores a default-port auth error whose detail is %j',
    async detail => {
      const other = await serve({ 'GET /v1/models': json({ detail }, 401) });
      expect(await detectRuntimes({ defaultHosts: [other.baseUrl], fetch: routedFetch({}) })).toEqual([]);
    }
  );

  it.each([400, 404, 500])('does not count a FastAPI-style %i as a keyed runtime', async status => {
    const other = await serve({ 'GET /v1/models': json({ detail: 'Not available' }, status) });
    expect(await detectRuntimes({ defaultHosts: [other.baseUrl], fetch: routedFetch({}) })).toEqual([]);
  });

  it('sends a configured API key and keeps a server that refuses without one', async () => {
    const guarded = await serve({ 'GET /v1/models': json({ error: { message: 'Invalid API key' } }, 401) });
    const keyed = await serve({
      'GET /v1/models': json({ object: 'list', data: [{ id: 'Qwen/Qwen3-8B', owned_by: 'vllm' }] }),
    });
    const found = await detectRuntimes({
      hosts: [guarded.baseUrl, { url: keyed.baseUrl, apiKey: 'sk-test' }],
      defaultHosts: [],
      fetch: routedFetch({}),
    });

    expect(found.map(entry => [entry.runtime.kind, entry.product, entry.health])).toEqual([
      ['openai-compatible', null, { ok: false, version: null, error: 'Requires an API key' }],
      ['openai-compatible', 'vllm', { ok: true, version: null, error: null }],
    ]);
    expect(keyed.requests.find(request => request.path === '/v1/models')?.headers.authorization).toBe('Bearer sk-test');
    expect(guarded.requests.find(request => request.path === '/v1/models')?.headers.authorization).toBeUndefined();
  });

  it('sends the API key to an Ollama behind an authenticating proxy', async () => {
    const proxied = await serve({
      'GET /api/version': (request, response) =>
        request.headers.authorization === 'Bearer sk-test'
          ? json({ version: '0.40.11' })(request, response)
          : json({ error: 'unauthorized' }, 401)(request, response),
      'GET /api/tags': (request, response) =>
        json({ models: [] }, request.headers.authorization === 'Bearer sk-test' ? 200 : 401)(request, response),
    });
    const found = await detectRuntimes({
      hosts: [{ url: proxied.baseUrl, apiKey: 'sk-test' }],
      defaultHosts: [],
      fetch: routedFetch({}),
    });

    expect(found[0]?.runtime.kind).toBe('ollama');
    expect(found[0]?.health).toEqual({ ok: true, version: '0.40.11', error: null });
    expect(await found[0]?.runtime.list()).toEqual([]);
  });

  it('skips a host that embeds credentials in its URL', async () => {
    const ollama = await serve(ollamaRoutes);
    const found = await detectRuntimes({
      hosts: [`http://user:secret@127.0.0.1:${ollama.port}`],
      defaultHosts: [],
      fetch: routedFetch({}),
    });
    expect(found).toEqual([]);
    expect(ollama.requests).toEqual([]);
  });

  it('reports a rejected key distinctly', async () => {
    const guarded = await serve({ 'GET /v1/models': json({ error: 'forbidden' }, 403) });
    const found = await detectRuntimes({
      hosts: [{ url: guarded.baseUrl, apiKey: 'wrong' }],
      defaultHosts: [],
      fetch: routedFetch({}),
    });
    expect(found[0]?.health.error).toBe('API key was rejected');
  });

  it('reports a keyed server on a default port but not a non-LLM service that refuses with HTML', async () => {
    const guarded = await serve({ 'GET /v1/models': json({ error: { message: 'Invalid API key' } }, 401) });
    const html: Handler = (_request, response) =>
      response.writeHead(403, { 'content-type': 'text/html' }).end('<html><body>Authentication required</body></html>');
    const jenkins = await serve({ 'GET /api/version': html, 'GET /v1/models': html });
    const found = await detectRuntimes({ fetch: routedFetch({ '8000': guarded, '8080': jenkins }) });
    expect(found.map(entry => [entry.runtime.id, entry.health.error])).toEqual([
      ['openai-compatible:127.0.0.1:8000', 'Requires an API key'],
    ]);
  });

  it('reports a configured host that refuses with a non-JSON body', async () => {
    const proxy = await serve({
      'GET /v1/models': (_request, response) => response.writeHead(401).end('Unauthorized'),
    });
    const found = await detectRuntimes({ hosts: [proxy.baseUrl], defaultHosts: [], fetch: routedFetch({}) });
    expect(found.map(entry => entry.health.error)).toEqual(['Requires an API key']);
  });

  it('ignores a server whose /api/version is not Ollama-shaped', async () => {
    const impostor = await serve({ 'GET /api/version': json({ status: 'ok' }) });
    const found = await detectRuntimes({ hosts: [impostor.baseUrl], defaultHosts: [], fetch: routedFetch({}) });
    expect(found).toEqual([]);
  });

  it('returns an empty list when nothing answers', async () => {
    expect(await detectRuntimes({ fetch: routedFetch({}) })).toEqual([]);
  });
});

describe('detectRuntimes endpoint identities', () => {
  it('keeps distinct proxy roots and HTTP/TLS endpoints separately addressable', async () => {
    const hosts = [
      'http://example.test:1234',
      'http://example.test:1234/first',
      'http://example.test:1234/second/v1/',
      'https://example.test:1234',
    ];
    const fetchImpl: FetchLike = async url =>
      url.endsWith('/v1/models')
        ? new Response(JSON.stringify({ data: [{ id: 'm', owned_by: 'vllm' }] }))
        : new Response('{}', { status: 404 });
    const found = await detectRuntimes({ hosts, defaultHosts: [], fetch: fetchImpl });
    expect(found.map(entry => entry.runtime.id)).toEqual([
      'openai-compatible:example.test:1234',
      'openai-compatible:http://example.test:1234/first',
      'openai-compatible:http://example.test:1234/second',
      'openai-compatible:https://example.test:1234',
    ]);
    expect(new Set(found.map(entry => entry.runtime.id)).size).toBe(hosts.length);
  });
});
