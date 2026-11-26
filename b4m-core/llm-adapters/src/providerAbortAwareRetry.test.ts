import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptions } from './backend';
import { ANTHROPIC_FEDERATED_KEY, AnthropicBackend } from './anthropicBackend';
import { DeepSeekBackend } from './deepseekBackend';
import { GeminiBackend } from './geminiBackend';
import { KimiBackend } from './kimiBackend';
import { OllamaBackend } from './ollamaBackend';
import { OPENAI_FEDERATED_KEY, OpenAIBackend } from './openaiBackend';
import { OpenAICompatibleBackend } from './openaiCompatibleBackend';
import { XAIBackend } from './xaiBackend';

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = vi.fn().mockResolvedValue({});
  },
  PutMetricDataCommand: class {},
  StandardUnit: { Count: 'Count' },
}));

const messages = [{ role: 'user' as const, content: 'Test input' }];
const opts = (signal: AbortSignal): Partial<ICompletionOptions> => ({
  stream: false,
  retryMode: 'abort-aware',
  abortSignal: signal,
  maxTokens: 200,
});
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() }) as never;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const rateLimited = () => json({ error: { message: 'rate limited' } }, 429, { 'retry-after': '120' });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sdkBackends = [
  { name: 'OpenAI', make: () => new OpenAIBackend('test', logger()), model: ChatModels.GPT4o, defaultRetries: 2 },
  { name: 'xAI', make: () => new XAIBackend('test', logger()), model: ChatModels.GROK_4_5, defaultRetries: 2 },
  { name: 'Kimi', make: () => new KimiBackend('test', logger()), model: ChatModels.KIMI_K2_6, defaultRetries: 2 },
  {
    name: 'DeepSeek',
    make: () => new DeepSeekBackend('test', logger()),
    model: ChatModels.DEEPSEEK_FLASH,
    defaultRetries: 2,
  },
  {
    name: 'Anthropic',
    make: () => new AnthropicBackend('test', logger()),
    model: ChatModels.CLAUDE_4_5_HAIKU,
    defaultRetries: 5,
  },
];

describe('completion SDKs with injected fake fetch', () => {
  it.each(sdkBackends)(
    '$name has no nested SDK retry after server throttling when opted in',
    async ({ make, model }) => {
      vi.useFakeTimers();
      const sent = Promise.withResolvers<void>();
      const request = vi.fn(async (_input: unknown, _init: RequestInit) => {
        sent.resolve();
        return rateLimited();
      });
      vi.stubGlobal('fetch', request);
      const backend = make();
      const controller = new AbortController();
      const callback = vi.fn();
      const completion = backend.complete(model, messages, opts(controller.signal), callback);
      const finished = vi.fn();
      const outcome = completion.catch(finished);
      await sent.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(finished).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();

      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
      expect(finished).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'AbortError' }));
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(request).toHaveBeenCalledOnce();
      await outcome;
    }
  );

  it.each(sdkBackends)('$name retries genuine SDK-wrapped transport failures', async ({ name, make, model }) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(async () =>
        name === 'Anthropic'
          ? json({
              id: 'message-1',
              type: 'message',
              role: 'assistant',
              model,
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'answer' }],
              usage: { input_tokens: 8, output_tokens: 2 },
            })
          : json({
              id: 'response-1',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 8, completion_tokens: 2 },
            })
      );
    vi.stubGlobal('fetch', fetch);
    const callback = vi.fn();
    const onRetry = vi.fn();
    const options = {
      ...opts(new AbortController().signal),
      _internal: { turnTelemetry: { onRetry, onSemaphoreWait: vi.fn() } },
    };
    const result = make().complete(model, messages, options, callback);
    const checked = expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(374);
    expect(fetch).toHaveBeenCalledOnce();
    if (name === 'OpenAI' || name === 'Anthropic') {
      expect(onRetry).toHaveBeenCalledExactlyOnceWith({ error: expect.any(Error), delayMs: expect.any(Number), model });
      const [{ delayMs }] = onRetry.mock.calls[0] as [{ delayMs: number }];
      expect(delayMs).toBeGreaterThanOrEqual(375);
      expect(delayMs).toBeLessThanOrEqual(625);
    }
    await vi.advanceTimersByTimeAsync(251);
    await checked;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      ['answer'],
      expect.objectContaining({ inputTokens: 8, outputTokens: 2 })
    );
  });

  it.each(sdkBackends.filter(({ name }) => ['OpenAI', 'DeepSeek', 'Kimi'].includes(name)))(
    '$name reports the actual non-streaming provider turn if the reply arrives after abort',
    async ({ make, model }) => {
      const controller = new AbortController();
      const deadline = new Error('deadline');
      const fetch = vi.fn(async () => {
        controller.abort(deadline);
        return json({
          id: 'response-1',
          object: 'chat.completion',
          created: 0,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'late answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 803, completion_tokens: 11, prompt_tokens_details: { cached_tokens: 23 } },
        });
      });
      vi.stubGlobal('fetch', fetch);
      const callback = vi.fn();
      await expect(make().complete(model, messages, opts(controller.signal), callback)).rejects.toBe(deadline);

      const measured = { inputTokens: 780, cacheReadInputTokens: 23, outputTokens: 11 };
      expect(fetch).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledExactlyOnceWith([], { ...measured, turnUsage: [measured] });
    }
  );

  it.each(sdkBackends)('$name retains the legacy SDK retry configuration', ({ make, defaultRetries }) => {
    expect((make() as unknown as { _api: { maxRetries: number } })._api.maxRetries).toBe(defaultRetries);
  });

  it('explicitly rejects federated credentials before either SDK can refresh or send', async () => {
    vi.stubEnv('OPENAI_IDENTITY_PROVIDER_ID', 'test-provider');
    vi.stubEnv('OPENAI_SERVICE_ACCOUNT_ID', 'test-service-account');
    vi.stubEnv('OPENAI_WIF_AUDIENCE', 'test-audience');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const callback = vi.fn();
    for (const { backend, model } of [
      { backend: new OpenAIBackend(OPENAI_FEDERATED_KEY, logger()), model: ChatModels.GPT4o },
      { backend: new AnthropicBackend(ANTHROPIC_FEDERATED_KEY, logger()), model: ChatModels.CLAUDE_4_5_HAIKU },
    ]) {
      await expect(backend.complete(model, messages, opts(signal), callback)).rejects.toThrow(/federated credentials/);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('explicitly rejects a local OpenAI-compatible backend before any discovery or wire request', async () => {
    const fetch = vi.fn();
    const backend = new OpenAICompatibleBackend({
      baseUrl: 'http://mock.invalid',
      label: 'test',
      fetch,
      product: null,
    });
    await expect(backend.complete('local-test', messages, opts(new AbortController().signal), vi.fn())).rejects.toThrow(
      /local OpenAI-compatible/
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('OpenAI joins the reasoning Chat Completions stream and reports late usage without text or tool events', async () => {
    const abort = new AbortController();
    const opened = Promise.withResolvers<void>();
    let wire!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        wire = controller;
      },
    });
    const enqueue = (event: unknown) =>
      wire.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => {
      opened.resolve();
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', fetch);

    const backend = new OpenAIBackend('test', logger());
    const callback = vi.fn();
    const settled = vi.fn();
    const pending = backend.complete(ChatModels.GPT5, messages, opts(abort.signal), callback).catch(settled);
    await opened.promise;
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe('/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: true });
    enqueue({ choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] });
    await Promise.resolve();
    expect(callback).not.toHaveBeenCalled();

    abort.abort();
    expect(init.signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    enqueue({
      choices: [{ index: 0, delta: { content: 'late' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 15, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
    });
    wire.close();
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'AbortError' }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      [],
      expect.objectContaining({ inputTokens: 12, cacheReadInputTokens: 3, outputTokens: 5 })
    );
  });

  it.each(sdkBackends)(
    '$name ignores unsolicited tool use without dispatching another request',
    async ({ name, make, model }) => {
      const calls = [{ id: 'tool-1', type: 'function', function: { name: 'unexpected', arguments: '{}' } }];
      const fetch = vi.fn(async () =>
        name === 'Anthropic'
          ? json({
              id: 'message-1',
              type: 'message',
              role: 'assistant',
              model,
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 'tool-1', name: 'unexpected', input: {} },
                { type: 'text', text: 'answer' },
              ],
              usage: { input_tokens: 13, output_tokens: 4 },
            })
          : json({
              id: 'response-1',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'answer', tool_calls: calls },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 13, completion_tokens: 4 },
            })
      );
      vi.stubGlobal('fetch', fetch);
      const callback = vi.fn();
      await make().complete(model, messages, opts(new AbortController().signal), callback);
      expect(fetch).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledOnce();
      const [parts, info] = callback.mock.calls[0];
      expect(parts).toContain('answer');
      expect(info.toolsUsed?.length ?? 0).toBe(0);
    }
  );

  it('OpenAI waits for actual transport cleanup after abort', async () => {
    const transport = Promise.withResolvers<Response>();
    const sent = Promise.withResolvers<AbortSignal | null | undefined>();
    const fetch = vi.fn((_input: unknown, init: RequestInit) => {
      sent.resolve(init.signal);
      return transport.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const backend = new OpenAIBackend('test', logger());
    const callback = vi.fn();
    const settled = vi.fn();
    const controller = new AbortController();
    const run = backend.complete(ChatModels.GPT4o, messages, opts(controller.signal), callback).catch(settled);
    const transportSignal = await sent.promise;
    controller.abort();
    expect(transportSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    transport.reject(new DOMException('transport closed', 'AbortError'));
    await run;
    expect(settled).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });
});

const geminiModel = ChatModels.GEMINI_2_5_FLASH_LITE;
const gemini = (generateContent: ReturnType<typeof vi.fn>) => {
  const backend = new GeminiBackend('test', logger());
  (backend as unknown as { _api: unknown })._api = { models: { generateContent } };
  return backend;
};

describe('Gemini non-streaming cancellation', () => {
  it('uses the same signal and reports only actual terminal usage after a late reply', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline elapsed');
    const generateContent = vi.fn(async () => {
      controller.abort(reason);
      return {
        candidates: [{ content: { parts: [{ text: 'late' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
      };
    });
    const callback = vi.fn();
    await expect(
      gemini(generateContent).complete(geminiModel, messages, opts(controller.signal), callback)
    ).rejects.toBe(reason);
    expect(generateContent).toHaveBeenCalledOnce();
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
      })
    );
    const [request] = generateContent.mock.calls[0] as unknown as [{ config: { abortSignal: AbortSignal } }];
    expect(request.config.abortSignal).not.toBe(controller.signal);
    expect(request.config.abortSignal.reason).toBe(reason);
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      [],
      expect.objectContaining({
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 3,
        turnUsage: [{ inputTokens: 100, outputTokens: 10 }],
      })
    );
  });

  it.each([false, true])('does not fabricate usage when a reply has none (transport rejects: %s)', async reject => {
    const controller = new AbortController();
    const generateContent = vi.fn(async () => {
      controller.abort();
      if (reject) throw new Error('transport closed');
      return { candidates: [{ content: { parts: [{ text: 'late' }] } }] };
    });
    const callback = vi.fn();
    await expect(
      gemini(generateContent).complete(geminiModel, messages, opts(controller.signal), callback)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(callback).not.toHaveBeenCalled();
  });

  it('cleans up the caller signal after repeated real SDK responses and propagates an in-flight abort', async () => {
    const controller = new AbortController();
    const transport = Promise.withResolvers<AbortSignal>();
    const fetch = vi.fn(async (_input: unknown, _init: RequestInit) =>
      json({
        candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const backend = new GeminiBackend('test', logger());
    for (let index = 0; index < 12; index++) {
      await backend.complete(geminiModel, messages, opts(controller.signal), vi.fn());
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    expect(fetch).toHaveBeenCalledTimes(12);

    fetch.mockImplementationOnce(async (_input, init) => {
      const signal = init.signal;
      if (!signal) throw new Error('Expected a transport signal');
      transport.resolve(signal);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('closed', 'AbortError')), { once: true });
      });
    });
    const callback = vi.fn();
    const pending = backend.complete(geminiModel, messages, opts(controller.signal), callback);
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const signal = await transport.promise;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    expect(signal.aborted).toBe(true);
    await result;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects if the final callback aborts after receiving provider usage', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled while the caller processed usage');
    const generateContent = vi.fn(async () => ({
      candidates: [{ content: { parts: [{ text: 'answer' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
    }));
    const callback = vi.fn(async () => controller.abort(reason));
    await expect(
      gemini(generateContent).complete(geminiModel, messages, opts(controller.signal), callback)
    ).rejects.toBe(reason);
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      ['answer'],
      expect.objectContaining({ inputTokens: 10, outputTokens: 2 })
    );
  });

  it('does not retry a Gemini HTTP error whose response headers are hidden by the SDK', async () => {
    const httpError = Object.assign(new Error('rate limited'), { status: 429 });
    const generateContent = vi.fn().mockRejectedValue(httpError);
    const signal = new AbortController().signal;
    await expect(gemini(generateContent).complete(geminiModel, messages, opts(signal), vi.fn())).rejects.toBe(
      httpError
    );
    expect(generateContent).toHaveBeenCalledOnce();
  });
});

describe('opt-in dispatch boundaries', () => {
  const backends: Array<{ name: string; make: () => ICompletionBackend; model: string }> = [
    ...sdkBackends,
    { name: 'Gemini', make: () => new GeminiBackend('test', logger()), model: geminiModel },
    { name: 'Ollama', make: () => new OllamaBackend('http://mock.invalid', logger()), model: 'local-test' },
  ];

  it.each(backends)('$name rejects a pre-aborted call without dispatching', async ({ make, model }) => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const reason = new Error('expired');
    const callback = vi.fn();
    await expect(make().complete(model, messages, opts(AbortSignal.abort(reason)), callback)).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects the legacy singleton OpenAI tool shape without choosing Responses or sending anything', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const backend = new OpenAIBackend('test', logger());
    const tool = { toolSchema: { name: 'tool', description: 'test', parameters: {} } };
    const tools = tool as unknown as ICompletionOptions['tools'];
    await expect(
      backend.complete(ChatModels.GPT5, messages, { ...opts(new AbortController().signal), tools }, vi.fn())
    ).rejects.toThrow(/without tools/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects when custom Ollama settings cannot join the request signal', async () => {
    const fetch = vi.fn();
    const requestSettings = vi.fn();
    const backend = new OllamaBackend('http://mock.invalid', logger(), { fetch, requestSettings });
    await expect(backend.complete('local-test', messages, opts(new AbortController().signal), vi.fn())).rejects.toThrow(
      /custom Ollama request settings/
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(requestSettings).not.toHaveBeenCalled();
  });

  it('Ollama reuses resolved details from a listing for an abort-aware completion', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return json({ models: [{ name: 'local-test' }] });
      if (String(input).endsWith('/api/show')) return json({ capabilities: ['completion'] });
      return json({ message: { content: 'answer' }, prompt_eval_count: 2, eval_count: 1 });
    });
    const backend = new OllamaBackend('http://mock.invalid', logger(), { fetch });
    await backend.getModelInfo();

    const controller = new AbortController();
    await backend.complete('local-test', messages, opts(controller.signal), vi.fn());
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/tags',
      '/api/show',
      '/api/chat',
    ]);
    expect(fetch.mock.calls.at(-1)?.[1]?.signal).toBe(controller.signal);
  });

  it('Ollama retries failed details on the first opted-in call and reuses the successful result', async () => {
    const show = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'lookup failed' }, 500))
      .mockResolvedValueOnce(json({ capabilities: ['completion'] }));
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return json({ models: [{ name: 'local-test' }] });
      if (String(input).endsWith('/api/show')) return show(init?.signal);
      return json({ message: { content: 'answer' }, prompt_eval_count: 2, eval_count: 1 });
    });
    const backend = new OllamaBackend('http://mock.invalid', logger(), { fetch });
    await backend.getModelInfo();
    expect(backend.toolSupportUnchecked('local-test')).toBe(true);

    const controller = new AbortController();
    await backend.complete('local-test', messages, opts(controller.signal), vi.fn());
    await backend.complete('local-test', messages, opts(new AbortController().signal), vi.fn());
    expect(show.mock.calls).toEqual([[undefined], [controller.signal]]);
  });

  it('Ollama uses an independent abortable lookup while a legacy lookup is pending', async () => {
    const legacyLookup = Promise.withResolvers<Response>();
    const legacyStarted = Promise.withResolvers<void>();
    const show = vi.fn(async (signal?: AbortSignal | null) => {
      if (signal) return json({ capabilities: ['completion'] });
      legacyStarted.resolve();
      return legacyLookup.promise;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return json({ models: [{ name: 'local-test' }] });
      if (String(input).endsWith('/api/show')) return show(init?.signal);
      return json({ message: { content: 'answer' }, prompt_eval_count: 2, eval_count: 1 });
    });
    const backend = new OllamaBackend('http://mock.invalid', logger(), { fetch });
    const listing = backend.getModelInfo();
    await legacyStarted.promise;
    const signal = new AbortController().signal;
    const completing = backend.complete('local-test', messages, opts(signal), vi.fn());
    try {
      await vi.waitFor(() => expect(show.mock.calls).toEqual([[undefined], [signal]]));
      await completing;
    } finally {
      legacyLookup.resolve(json({ capabilities: ['completion'] }));
      await listing;
    }
  });

  it('Ollama uses the same signal for model admission and completion and suppresses a late reply', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith('/api/show')) return json({ capabilities: ['completion'] });
      expect(String(input)).toMatch(/\/api\/chat$/);
      controller.abort();
      return json({
        message: { content: 'late' },
        prompt_eval_count: 13,
        eval_count: 2,
        done_reason: 'stop',
      });
    });
    const backend = new OllamaBackend('http://mock.invalid', logger(), { fetch });
    const callback = vi.fn();

    await expect(backend.complete('local-test', messages, opts(controller.signal), callback)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => init?.signal)).toEqual([controller.signal, controller.signal]);
    expect(callback).toHaveBeenCalledExactlyOnceWith([], expect.objectContaining({ inputTokens: 13, outputTokens: 2 }));
  });
});

describe('single-attempt accounting transport', () => {
  const direct = sdkBackends.filter(({ name }) => name === 'OpenAI' || name === 'Anthropic');

  it.each(direct)('$name never hides a throttled or failed transport retry', async ({ make, model }) => {
    vi.useFakeTimers();
    for (const failure of ['throttle', 'transport'] as const) {
      const fetch = vi.fn(async () => {
        if (failure === 'transport') throw new TypeError('fetch failed');
        return rateLimited();
      });
      vi.stubGlobal('fetch', fetch);
      await expect(
        make().complete(
          model,
          messages,
          { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
          vi.fn()
        )
      ).rejects.toBeDefined();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it.each(direct)(
    '$name rejects absent provider usage instead of fabricating zero tokens',
    async ({ name, make, model }) => {
      const fetch = vi.fn(async () =>
        name === 'Anthropic'
          ? json({
              id: 'message',
              type: 'message',
              role: 'assistant',
              model,
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'answer' }],
            })
          : json({
              id: 'response',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
            })
      );
      vi.stubGlobal('fetch', fetch);
      const callback = vi.fn();
      await expect(
        make().complete(
          model,
          messages,
          { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
          callback
        )
      ).rejects.toThrow(/omitted measured usage/);
      expect(fetch).toHaveBeenCalledOnce();
      expect(callback).not.toHaveBeenCalled();
    }
  );

  it.each(direct)(
    '$name joins an aborted request and retains returned measured usage',
    async ({ name, make, model }) => {
      const transport = Promise.withResolvers<Response>();
      const sent = Promise.withResolvers<AbortSignal | null | undefined>();
      const fetch = vi.fn((_input: unknown, init: RequestInit) => {
        sent.resolve(init.signal);
        return transport.promise;
      });
      vi.stubGlobal('fetch', fetch);
      const controller = new AbortController();
      const callback = vi.fn();
      const finished = vi.fn();
      const pending = make()
        .complete(model, messages, { ...opts(controller.signal), retryMode: 'single-attempt' }, callback)
        .catch(finished);
      const signal = await sent.promise;
      controller.abort(new Error('deadline'));
      await Promise.resolve();
      expect(signal?.aborted).toBe(true);
      expect(finished).not.toHaveBeenCalled();
      transport.resolve(
        name === 'Anthropic'
          ? json({
              id: 'message',
              type: 'message',
              role: 'assistant',
              model,
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'late' }],
              usage: { input_tokens: 8, output_tokens: 2 },
            })
          : json({
              id: 'response',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 8, completion_tokens: 2 },
            })
      );
      await pending;
      expect(fetch).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledExactlyOnceWith(
        [],
        expect.objectContaining({ inputTokens: 8, outputTokens: 2 })
      );
      expect(finished).toHaveBeenCalledOnce();
    }
  );

  it('keeps reasoning models on a single non-streaming Chat request without native tool recursion', async () => {
    const fetch = vi.fn(async () =>
      json({
        id: 'response',
        object: 'chat.completion',
        created: 0,
        model: ChatModels.GPT5,
        choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const callback = vi.fn();
    await new OpenAIBackend('test', logger()).complete(
      ChatModels.GPT5,
      messages,
      { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
      callback
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(new URL(String(url)).pathname).toBe('/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: ChatModels.GPT5, stream: false });
    expect(callback).toHaveBeenCalledWith(['answer'], expect.objectContaining({ inputTokens: 8, outputTokens: 2 }));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it.each(direct)(
    '$name latches known usage before malformed content processing fails',
    async ({ name, make, model }) => {
      const fetch = vi.fn(async () =>
        name === 'Anthropic'
          ? json({
              id: 'message',
              type: 'message',
              role: 'assistant',
              model,
              stop_reason: 'end_turn',
              content: [null],
              usage: { input_tokens: 8, output_tokens: 2 },
            })
          : json({
              id: 'response',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 2 },
            })
      );
      vi.stubGlobal('fetch', fetch);
      const callback = vi.fn();
      await expect(
        make().complete(
          model,
          messages,
          { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
          callback
        )
      ).rejects.toBeDefined();
      expect(callback).toHaveBeenCalledWith([], expect.objectContaining({ inputTokens: 8, outputTokens: 2 }));
      expect(fetch).toHaveBeenCalledOnce();
    }
  );

  it.each(direct)(
    '$name rejects invalid raw cache usage before normalization can hide it',
    async ({ name, make, model }) => {
      const fetch = vi.fn(async () =>
        name === 'Anthropic'
          ? json({
              id: 'message',
              type: 'message',
              role: 'assistant',
              model,
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'answer' }],
              usage: {
                input_tokens: 8,
                output_tokens: 2,
                cache_creation_input_tokens: 1,
                cache_creation: { ephemeral_1h_input_tokens: 2 },
              },
            })
          : json({
              id: 'response',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 8, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 9 } },
            })
      );
      vi.stubGlobal('fetch', fetch);
      const callback = vi.fn();
      await expect(
        make().complete(
          model,
          messages,
          { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
          callback
        )
      ).rejects.toThrow(/invalid measured cache usage/);
      expect(callback).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ['gpt-4o', 'gpt-4o-2024-08-06'],
    ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'],
    ['gpt-4.1', 'gpt-4.1-2025-04-14'],
    ['gpt-5', 'gpt-5-2025-08-07'],
    ['gpt-4', 'gpt-4-0613'],
    ['gpt-4-turbo', 'gpt-4-turbo-2024-04-09'],
  ])('captures one paid OpenAI response when %s resolves to %s', async (requestedModel, returnedModel) => {
    const fetch = vi.fn(async () =>
      json({
        id: 'response',
        object: 'chat.completion',
        created: 0,
        model: returnedModel,
        choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const callback = vi.fn();
    await new OpenAIBackend('test', logger()).complete(
      requestedModel,
      messages,
      { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
      callback
    );
    expect(callback).toHaveBeenCalledWith(['answer'], expect.objectContaining({ inputTokens: 8, outputTokens: 2 }));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(direct)(
    '$name rejects missing, mismatched, or unproven aliased model identity before usage capture',
    async ({ name, make, model }) => {
      for (const returnedModel of [undefined, 'different-model', model + '-20990101']) {
        const fetch = vi.fn(async () =>
          name === 'Anthropic'
            ? json({
                id: 'message',
                type: 'message',
                role: 'assistant',
                model: returnedModel,
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'answer' }],
                usage: { input_tokens: 8, output_tokens: 2 },
              })
            : json({
                id: 'response',
                object: 'chat.completion',
                created: 0,
                model: returnedModel,
                choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 8, completion_tokens: 2 },
              })
        );
        vi.stubGlobal('fetch', fetch);
        const callback = vi.fn();
        await expect(
          make().complete(
            model,
            messages,
            { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
            callback
          )
        ).rejects.toThrow('Provider response model identity is unverified');
        expect(callback).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledOnce();
      }
    }
  );

  it('accepts the exact default direct Anthropic identity before reporting measured usage', async () => {
    const model = ChatModels.CLAUDE_4_6_SONNET;
    const fetch = vi.fn(async () =>
      json({
        id: 'message',
        type: 'message',
        role: 'assistant',
        model,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const callback = vi.fn();
    await new AnthropicBackend('test', logger()).complete(
      model,
      messages,
      { ...opts(new AbortController().signal), retryMode: 'single-attempt' },
      callback
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith([], expect.objectContaining({ inputTokens: 8, outputTokens: 2 }));
    expect(callback).toHaveBeenCalledWith(['answer'], expect.objectContaining({ inputTokens: 8, outputTokens: 2 }));
  });
});
