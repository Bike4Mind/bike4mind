import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { ChatModels } from '@bike4mind/common';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { publicVideoModel } from './media/__fixtures__/videoModels';
import { ModelCatalog, parseReasoningPage, resolveDefaultModel, selectUsableModels } from './ModelCatalog';
import { GIB, stubArch, unifiedMachine } from './fitStub.testHelper';
import { forgetLocalContexts, OllamaLocal } from './OllamaLocal';

vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  estimateFit: (await import('./fitStub.testHelper')).stubEstimateFit,
}));

function wireModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude 4.5 Sonnet',
    type: 'text',
    backend: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    ...overrides,
  };
}

describe('selectUsableModels', () => {
  it("carries the model's output ceiling from the catalog's max_tokens", () => {
    expect(selectUsableModels([wireModel({ max_tokens: 16_384 })])[0]).toMatchObject({ maxOutputTokens: 16_384 });
    expect(selectUsableModels([wireModel()])[0]).not.toHaveProperty('maxOutputTokens');
  });

  it('offers the 1-hour prompt cache only on a direct-Anthropic model that takes it', () => {
    const opus = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
    expect(selectUsableModels([wireModel(opus)])[0]).toMatchObject({ supportsOneHourCache: true });
    expect(selectUsableModels([wireModel({ id: 'claude-opus-4-1-20250805' })])[0]).not.toHaveProperty(
      'supportsOneHourCache'
    );
    expect(
      selectUsableModels([wireModel({ ...opus, id: 'global.anthropic.claude-opus-5-5', backend: 'bedrock' })])[0]
    ).not.toHaveProperty('supportsOneHourCache');
  });

  it('carries well-formed pricing tiers and drops malformed ones', () => {
    const pricing = {
      200000: { input: 3e-6, output: 15e-6, cache_write: 3.75e-6 },
      1000000: { input: 'x', output: 1 },
      flat: { input: 1, output: 1 },
    };
    expect(selectUsableModels([wireModel({ pricing })])[0]?.pricing).toEqual({
      200000: { input: 3e-6, output: 15e-6, cache_write: 3.75e-6 },
    });
    expect(selectUsableModels([wireModel({ pricing: { flat: { input: 1, output: 1 } } })])[0]).not.toHaveProperty(
      'pricing'
    );
  });

  it('marks a model the server lists as disabled, and only on an explicit true', () => {
    expect(selectUsableModels([wireModel({ disabled: true })])[0]).toMatchObject({ disabled: true });
    expect(selectUsableModels([wireModel({ disabled: 'yes' })])[0]).not.toHaveProperty('disabled');
    expect(selectUsableModels([wireModel()])[0]).not.toHaveProperty('disabled');
  });

  it('carries the release date only when the server sent a non-empty string', () => {
    expect(selectUsableModels([wireModel({ releaseDate: '2025-04-14' })])[0]).toMatchObject({
      releaseDate: '2025-04-14',
    });
    expect(selectUsableModels([wireModel()])[0]).not.toHaveProperty('releaseDate');
    expect(selectUsableModels([wireModel({ releaseDate: '' })])[0]).not.toHaveProperty('releaseDate');
    expect(selectUsableModels([wireModel({ releaseDate: 20250414 })])[0]).not.toHaveProperty('releaseDate');
  });

  it('keeps only text models that can call tools', () => {
    const models = selectUsableModels([
      wireModel(),
      wireModel({ id: 'dall-e-3', type: 'image' }),
      wireModel({ id: 'text-no-tools', supportsTools: false }),
      wireModel({ id: 'text-tools-unstated', supportsTools: undefined }),
    ]);

    expect(models.map(model => model.id)).toEqual(['claude-sonnet-4-5-20250929']);
  });

  it('falls back to the id when the server sent no display name', () => {
    expect(selectUsableModels([wireModel({ id: 'qwen3.5', name: '' })])[0]).toMatchObject({
      id: 'qwen3.5',
      name: 'qwen3.5',
    });
  });

  it('gives a thinking switch only to an Ollama model the server says can think', () => {
    const [thinker, plain, hosted] = selectUsableModels([
      wireModel({ id: 'qwen3:8b', backend: 'ollama', can_think: true }),
      wireModel({ id: 'llama3.2', backend: 'ollama', can_think: false }),
      wireModel({ id: 'claude-sonnet-4-5-20250929', backend: 'anthropic', can_think: true }),
    ]);

    expect(thinker).toMatchObject({ thinkingToggle: true });
    expect(plain).not.toHaveProperty('thinkingToggle');
    expect(hosted).not.toHaveProperty('thinkingToggle');
  });

  it('treats a non-array payload as no models rather than throwing', () => {
    expect(selectUsableModels(undefined)).toEqual([]);
    expect(selectUsableModels({ models: [] })).toEqual([]);
  });

  it('offers the effort levels the server publishes, and the old four where it publishes none', () => {
    const gpt = wireModel({ id: ChatModels.GPT5, backend: 'openai', can_think: true });
    const [listed] = selectUsableModels(
      [gpt],
      new Map([[ChatModels.GPT5, { efforts: ['none', 'low', 'xhigh'] as const }]])
    );
    expect(listed).toMatchObject({
      supportsReasoningEffort: true,
      controls: { effort: { levels: ['none', 'low', 'xhigh'] } },
    });
    expect(selectUsableModels([gpt])[0]?.controls?.effort?.levels).toEqual(['minimal', 'low', 'medium', 'high']);

    const [none] = selectUsableModels([gpt], new Map([[ChatModels.GPT5, { efforts: [] }]]));
    expect(none).toMatchObject({ supportsReasoningEffort: false });
    expect(none?.controls).not.toHaveProperty('effort');
  });

  it('keeps max output above the reasoning floor where the server says reasoning spends it', () => {
    const row = wireModel({ id: 'some-reasoner', backend: 'openai', can_think: true, max_tokens: 128_000 });
    const output = (reasons?: boolean) =>
      selectUsableModels(
        [row],
        reasons === undefined ? undefined : new Map([['some-reasoner', { reasonsWithinOutputBudget: reasons }]])
      )[0]?.controls?.maxOutputTokens;
    expect(output(true)).toMatchObject({ min: 64_000, max: 128_000, includesThinking: true });
    expect(output(false)).toMatchObject({ min: 1024, max: 128_000 });
    expect(output(false)).not.toHaveProperty('includesThinking');
    expect(output(undefined)).toMatchObject({ min: 1024 });
  });

  it('pins temperature for a model the catalog dispatches with max_completion_tokens', () => {
    const [model] = selectUsableModels([
      wireModel({
        id: 'some-new-reasoner',
        backend: 'openai',
        can_think: true,
        dispatchProfile: { maxTokensParam: 'max_completion_tokens' },
      }),
    ]);
    expect(model?.controls?.temperature?.locked?.value).toBe(1);
  });
});

describe('parseReasoningPage', () => {
  it('reads what each row states and drops levels it does not know', () => {
    expect(
      parseReasoningPage({
        data: [
          { id: 'a', reasoning_efforts: ['none', 'turbo', 'high'], reasons_within_output_budget: true },
          { id: 'b' },
          { id: 'c', reasons_within_output_budget: false, reasoning_efforts: 'high' },
          { reasoning_efforts: ['low'] },
          null,
        ],
        next_cursor: 'next',
      })
    ).toEqual({
      rows: [
        ['a', { efforts: ['none', 'high'], reasonsWithinOutputBudget: true }],
        ['c', { reasonsWithinOutputBudget: false }],
      ],
      nextCursor: 'next',
    });
  });

  it('answers null for anything that is not a page', () => {
    expect(parseReasoningPage({ models: [] })).toBeNull();
    expect(parseReasoningPage(undefined)).toBeNull();
    expect(parseReasoningPage({ data: [], next_cursor: '' })).toEqual({ rows: [], nextCursor: null });
  });
});

describe('resolveDefaultModel', () => {
  const models = selectUsableModels([wireModel({ id: 'a' }), wireModel({ id: 'b' }), wireModel({ id: 'c' })]);

  it('takes the first preference the deployment offers, in order', () => {
    expect(resolveDefaultModel(models, ['c', 'b'])).toBe('c');
  });

  it('skips a preference the deployment does not offer and tries the next', () => {
    expect(resolveDefaultModel(models, ['not-here', 'b'])).toBe('b');
  });

  it('skips an absent preference, so a user who never picked lands on the built-in default', () => {
    expect(resolveDefaultModel(models, [null, 'b'])).toBe('b');
  });

  it('falls back to the first model the server listed, never to another hardcoded guess', () => {
    expect(resolveDefaultModel(models, ['not-here', 'nor-this'])).toBe('a');
  });

  it('answers null when the deployment offers nothing', () => {
    expect(resolveDefaultModel([], ['anything'])).toBeNull();
  });
});

describe('ModelCatalog', () => {
  /** GET /api/models; the effort levels on /api/v1/models go to `effortsPage` instead. */
  let get: Mock<(path: string, config?: unknown) => Promise<unknown>>;
  let effortsPage: Mock<(config?: unknown) => Promise<unknown>>;
  let environmentUrl: string;
  let catalog: ModelCatalog;
  const client = () =>
    ({
      get: (path: string, config?: unknown) => (path === '/api/v1/models' ? effortsPage(config) : get(path, config)),
    }) as unknown as AuthenticatedApiClient;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    get = vi.fn().mockResolvedValue({ models: [wireModel(), wireModel({ id: 'dall-e-3', type: 'image' })] });
    effortsPage = vi.fn().mockResolvedValue({ data: [], next_cursor: null });
    environmentUrl = 'http://localhost:3000';
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: client,
        getEnvironmentUrl: () => environmentUrl,
      },
      { models: async () => [] } as never
    );
  });

  it('serves a second read from cache', async () => {
    expect((await catalog.list()).models.map(model => model.id)).toEqual(['claude-sonnet-4-5-20250929']);
    await catalog.list();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('expires a catalog containing local models quickly so a stopped runtime disappears', async () => {
    const local = { models: vi.fn().mockResolvedValue([{ id: 'local:ollama:qwen', name: 'qwen' }]) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: client,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    await catalog.list();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001);
    local.models.mockResolvedValue([]);
    expect((await catalog.list()).models.some(model => model.id.startsWith('local:'))).toBe(false);
  });

  it('keeps the last local list past its expiry, without asking the device, until forgotten', async () => {
    const local = { models: vi.fn().mockResolvedValue([{ id: 'local:ollama:qwen', name: 'qwen' }]) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => null,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    expect(catalog.lastLocal()).toBeNull();
    await catalog.listLocal();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    expect(catalog.lastLocal()?.map(model => model.id)).toEqual(['local:ollama:qwen']);
    expect(local.models).toHaveBeenCalledTimes(1);
    catalog.forgetLocal();
    expect(catalog.lastLocal()).toBeNull();
  });

  it('keeps a local list read after forgetLocal over one that started before it', async () => {
    const finishes: ((models: unknown[]) => void)[] = [];
    const local = { models: vi.fn(() => new Promise<unknown[]>(resolve => finishes.push(resolve))) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => null,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    const older = catalog.listLocal(true);
    catalog.forgetLocal();
    const newer = catalog.listLocal(true);
    finishes[1]([{ id: 'local:srv-a:qwen', name: 'qwen' }]);
    await newer;
    finishes[0]([
      { id: 'local:srv-a:qwen', name: 'qwen', unavailable: 'a is still listing its models', pending: true },
    ]);
    await older;
    expect(catalog.lastLocal()).toEqual([{ id: 'local:srv-a:qwen', name: 'qwen' }]);
  });

  it('does not cache a local read that a forgetLocal interrupted', async () => {
    let finish: (models: unknown[]) => void = () => undefined;
    const local = { models: vi.fn(() => new Promise<unknown[]>(resolve => (finish = resolve))) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => null,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    const read = catalog.listLocal();
    catalog.forgetLocal();
    finish([{ id: 'local:ollama:qwen', name: 'qwen' }]);
    await read;
    expect(catalog.lastLocal()).toBeNull();
    const again = catalog.listLocal();
    finish([]);
    await again;
    expect(local.models).toHaveBeenCalledTimes(2);
  });

  it('caches a local read during which the cache was only expired', async () => {
    const local = {
      models: vi.fn(async () => {
        catalog.expireLocal();
        return [{ id: 'local:srv-a:qwen', name: 'qwen' }];
      }),
    };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => null,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    await catalog.listLocal();
    expect(catalog.lastLocal()?.map(model => model.id)).toEqual(['local:srv-a:qwen']);
    await catalog.listLocal();
    expect(local.models).toHaveBeenCalledOnce();
  });

  it('keeps the last local list for turns once expired, while the next list reads again', async () => {
    const local = { models: vi.fn().mockResolvedValue([{ id: 'local:srv-a:qwen', name: 'qwen' }]) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => null,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    await catalog.listLocal();
    catalog.expireLocal();
    expect(catalog.lastLocal()?.map(model => model.id)).toEqual(['local:srv-a:qwen']);
    expect(catalog.cached()).toBeNull();
    await catalog.listLocal();
    expect(local.models).toHaveBeenCalledTimes(2);
  });

  it('merges the local list it read, even when forgetLocal runs during the hosted read', async () => {
    let finishHosted: (value: unknown) => void = () => undefined;
    get.mockImplementation(() => new Promise(resolve => (finishHosted = resolve)));
    const local = { models: vi.fn().mockResolvedValue([{ id: 'local:ollama:qwen', name: 'qwen' }]) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: client,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    const listed = catalog.list();
    await vi.waitFor(() => expect(catalog.lastLocal()).not.toBeNull(), { timeout: 5_000 });
    catalog.forgetLocal();
    finishHosted({ models: [wireModel()] });
    expect((await listed).models.map(model => model.id)).toEqual(['claude-sonnet-4-5-20250929', 'local:ollama:qwen']);
  });

  it('discovers a newly started local runtime without expiring or refetching the hosted list', async () => {
    const local = { models: vi.fn().mockResolvedValue([]) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: client,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    await catalog.list();
    local.models.mockResolvedValue([{ id: 'local:ollama:qwen', name: 'qwen' }]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001);
    expect((await catalog.list()).models.map(model => model.id)).toEqual([
      'claude-sonnet-4-5-20250929',
      'local:ollama:qwen',
    ]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('asks the device and the server at the same time', async () => {
    let finishLocal: (models: unknown[]) => void = () => undefined;
    const local = {
      models: vi.fn(
        () =>
          new Promise<unknown[]>(resolve => {
            finishLocal = resolve;
          })
      ),
    };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: client,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    const listed = catalog.list();
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce(), { timeout: 5_000 });
    finishLocal([{ id: 'local:ollama:qwen', name: 'qwen' }]);
    expect((await listed).models.map(model => model.id)).toEqual(['claude-sonnet-4-5-20250929', 'local:ollama:qwen']);
  });

  it("shows a local model's context as it is now: grown by a conversation, or sized again after Settings", async () => {
    // The stub estimator: 64K is the most that fits 13 GiB, 32K the most that fits 10 GiB.
    let hardware = unifiedMachine(13);
    const footprint = () => ({ arch: stubArch(131072), weightsBytes: 4 * GIB, hardware });
    const replies = [
      () =>
        Response.json(
          { error: 'request (70000 tokens) exceeds the available context size (65536 tokens), try increasing it' },
          { status: 400 }
        ),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen', size: 1, digest: 'one' }] });
        if (url.endsWith('/api/show'))
          return Response.json({ capabilities: ['completion'], model_info: { 'llama.context_length': 131072 } });
        return (replies.shift() ?? (() => new Response(`${JSON.stringify({ done: true })}\n`)))();
      })
    );
    const local = new OllamaLocal(undefined, {
      setting: async () => ({ mode: 'auto' }),
      footprint: async () => footprint(),
      cachedFootprint: footprint,
    });
    catalog = new ModelCatalog(
      { logger: { debug: vi.fn(), warn: vi.fn() }, getApiClient: () => null, getEnvironmentUrl: () => environmentUrl },
      local
    );
    try {
      const contextOf = async () => (await catalog.list()).models.find(model => model.id === 'local:ollama:qwen');
      expect((await contextOf())?.contextWindow).toBe(65536);
      await local.stream(
        { model: 'local:ollama:qwen', messages: [{ role: 'user', content: 'long' }] },
        () => undefined
      );
      const grown = await local.contextTokens('local:ollama:qwen');
      expect(grown).toBeGreaterThan(65536);
      expect(catalog.cached()?.find(model => model.id === 'local:ollama:qwen')?.contextWindow).toBe(grown);
      expect((await contextOf())?.contextWindow).toBe(grown);
      expect((await contextOf())?.controls?.maxOutputTokens?.max).toBe(grown);

      hardware = unifiedMachine(10);
      forgetLocalContexts();
      catalog.forgetLocal();
      expect((await contextOf())?.contextWindow).toBe(32768);
    } finally {
      forgetLocalContexts();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])('offers local models while signed out or the hosted catalog fails (%s)', async failed => {
    if (failed) get.mockRejectedValue(new Error('offline'));
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => (failed ? client() : null),
        getEnvironmentUrl: () => environmentUrl,
      },
      { models: async () => [{ id: 'local:ollama:qwen', name: 'qwen' }] } as never
    );
    expect(await catalog.list()).toEqual({ models: [{ id: 'local:ollama:qwen', name: 'qwen' }] });
    if (!failed) expect(get).not.toHaveBeenCalled();
  });

  it('retains thinking capability through an expired failed read without offering stale models', async () => {
    get.mockResolvedValueOnce({ models: [wireModel({ id: 'qwen3:8b', backend: 'ollama', can_think: true })] });
    await catalog.list();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    get.mockRejectedValueOnce(new Error('temporary failure'));

    expect(await catalog.list()).toMatchObject({ models: [], error: expect.any(String) });
    expect(catalog.cached()).toBeNull();
    expect(catalog.lastKnownThinkingToggle('qwen3:8b')).toBe(true);
    expect(catalog.lastKnownThinkingToggle('unknown')).toBeUndefined();

    environmentUrl = 'https://other.example.com';
    expect(catalog.lastKnownThinkingToggle('qwen3:8b')).toBeUndefined();
  });

  it('forgets old thinking capabilities when a successful refresh removes the model', async () => {
    get.mockResolvedValueOnce({ models: [wireModel({ id: 'qwen3:8b', backend: 'ollama', can_think: true })] });
    await catalog.list();
    get.mockResolvedValueOnce({ models: [] });
    await catalog.list(true);
    get.mockRejectedValueOnce(new Error('temporary failure'));
    await catalog.list();

    expect(catalog.lastKnownThinkingToggle('qwen3:8b')).toBeUndefined();
  });

  it('refetches when the environment changed, so one server never shows another one models', async () => {
    await catalog.list();
    environmentUrl = 'https://hosted.example.com';

    expect(catalog.cached()).toBeNull();
    await catalog.list();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('refetches on force, which is what the picker retry needs', async () => {
    await catalog.list();
    await catalog.list(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("re-reads device models on 'local' but serves the hosted list from cache", async () => {
    const local = { models: vi.fn().mockResolvedValue([]) };
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: client,
        getEnvironmentUrl: () => environmentUrl,
      },
      local as never
    );
    await catalog.list();
    local.models.mockResolvedValue([{ id: 'local:ollama:qwen', name: 'qwen' }]);

    const refreshed = await catalog.list('local');
    expect(refreshed.models.map(model => model.id)).toEqual(['claude-sonnet-4-5-20250929', 'local:ollama:qwen']);
    expect(local.models).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);

    await catalog.list(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  // A network blip must not be cached as "this server has no models" for the rest of the TTL.
  it('reports a failed lookup as an error and retries on the next read', async () => {
    get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const failed = await catalog.list();
    expect(failed.models).toEqual([]);
    expect(failed.error).toMatch(/could not load/i);
    expect(catalog.cached()).toBeNull();

    expect((await catalog.list()).models).toHaveLength(1);
  });

  // Distinct from the case above: the server answered, and genuinely has nothing to offer.
  it('reports an empty catalog without an error', async () => {
    get.mockResolvedValueOnce({ models: [] });
    expect(await catalog.list()).toEqual({ models: [] });
  });

  it('reads the effort levels from every page of the public list beside the catalog', async () => {
    get.mockResolvedValue({
      models: [wireModel({ id: 'first', backend: 'openai' }), wireModel({ id: 'second', backend: 'openai' })],
    });
    effortsPage
      .mockResolvedValueOnce({ data: [{ id: 'first', reasoning_efforts: ['none', 'high'] }], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ data: [{ id: 'second', reasoning_efforts: ['xhigh'] }], next_cursor: null });

    await catalog.list();
    await vi.waitFor(() => expect(effortsPage).toHaveBeenCalledTimes(2));
    const levels = (await catalog.list()).models.map(model => model.controls?.effort?.levels);
    expect(levels).toEqual([['none', 'high'], ['xhigh']]);
    expect(effortsPage.mock.calls[1]?.[0]).toMatchObject({
      params: { limit: 100, cursor: 'page-2' },
      timeout: 5_000,
    });
  });

  it('lists without waiting for the effort levels, and updates the cached list when they land', async () => {
    const changed = vi.fn();
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: client,
        getEnvironmentUrl: () => environmentUrl,
        changed,
      },
      { models: async () => [] } as never
    );
    get.mockResolvedValue({ models: [wireModel({ id: ChatModels.GPT5, backend: 'openai' })] });
    let land: (page: unknown) => void = () => {};
    effortsPage.mockReturnValueOnce(new Promise(resolve => (land = resolve)));

    const { models } = await catalog.list();
    expect(models[0]?.controls?.effort?.levels).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(changed).not.toHaveBeenCalled();

    land({ data: [{ id: ChatModels.GPT5, reasoning_efforts: ['low', 'medium', 'high'] }], next_cursor: null });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(catalog.cached()?.[0]?.controls?.effort?.levels).toEqual(['low', 'medium', 'high']);

    // A later refresh lists with what is known at once, and says nothing when the read brings no change.
    effortsPage.mockResolvedValue({
      data: [{ id: ChatModels.GPT5, reasoning_efforts: ['low', 'medium', 'high'] }],
      next_cursor: null,
    });
    expect((await catalog.list(true)).models[0]?.controls?.effort?.levels).toEqual(['low', 'medium', 'high']);
    await vi.waitFor(() => expect(effortsPage).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('reads the effort levels once while a read is already on its way', async () => {
    get.mockResolvedValue({ models: [wireModel({ id: ChatModels.GPT5, backend: 'openai' })] });
    let land: (page: unknown) => void = () => {};
    effortsPage.mockReturnValueOnce(new Promise(resolve => (land = resolve)));
    await Promise.all([catalog.list(true), catalog.list(true)]);
    await catalog.list(true);
    expect(effortsPage).toHaveBeenCalledTimes(1);

    land({ data: [], next_cursor: null });
    await vi.waitFor(async () => {
      await catalog.list(true);
      expect(effortsPage).toHaveBeenCalledTimes(2);
    });
  });

  it.each([
    ['fails', () => effortsPage.mockRejectedValue(new Error('not found'))],
    ['answers another shape', () => effortsPage.mockResolvedValue({ models: [] })],
  ])('keeps the list and the old effort levels when the public list %s', async (_, arrange) => {
    get.mockResolvedValue({ models: [wireModel({ id: ChatModels.GPT5, backend: 'openai' })] });
    arrange();
    const { models, error } = await catalog.list();
    expect(error).toBeUndefined();
    expect(models[0]?.controls?.effort?.levels).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('refuses to guess while signed out', async () => {
    catalog = new ModelCatalog(
      {
        logger: { debug: vi.fn(), warn: vi.fn() },
        getApiClient: () => null,
        getEnvironmentUrl: () => environmentUrl,
      },
      { models: async () => [] } as never
    );

    expect((await catalog.list()).error).toMatch(/sign in/i);
  });
});

describe('ModelCatalog.listVideoModels', () => {
  const gemini = publicVideoModel('gemini-omni-1.1-flash');

  function catalogWith(get: ReturnType<typeof vi.fn>) {
    return new ModelCatalog({
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => ({ get }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
    });
  }

  it('reads the usable video models once and serves the turns after from cache', async () => {
    const get = vi.fn().mockResolvedValue({ models: [gemini] });
    const catalog = catalogWith(get);

    expect((await catalog.listVideoModels()).map(model => model.id)).toEqual([gemini.id]);
    await catalog.listVideoModels();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/v1/video-models', expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it('caches "none" and a failure only briefly, so neither costs every turn a round trip', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const get = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ models: [gemini] });
      const catalog = catalogWith(get);

      expect(await catalog.listVideoModels()).toEqual([]);
      expect(await catalog.listVideoModels()).toEqual([]);
      expect(get).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      expect((await catalog.listVideoModels()).map(model => model.id)).toEqual([gemini.id]);
    } finally {
      vi.useRealTimers();
    }
  });
});
