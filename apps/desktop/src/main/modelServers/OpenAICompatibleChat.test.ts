import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike, OpenAICompatibleProduct } from '@bike4mind/local-models';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import type { ModelLoadSettings } from '@shared/modelSettings';
import { ServerCredentialsError, ServerForbiddenError } from './errors';
import type { LearnedThinker } from './ModelServerStore';
import {
  isEffortTemplate,
  OpenAICompatibleChat,
  PROPS_CONCURRENCY,
  NO_PROPS_EXPIRY_MS,
  TEMPLATE_RETRY_MS,
  toOpenAIMessages,
} from './OpenAICompatibleChat';

const BASE = 'http://127.0.0.1:18080';
const MODEL = 'local:srv-abc123:qwen2.5-0.5b';

function sse(frames: readonly (object | string)[]): Response {
  const text = frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chat(
  fetch: FetchLike,
  product: OpenAICompatibleProduct | null = 'llama-server',
  toolsChanged?: () => void,
  extra: Partial<ConstructorParameters<typeof OpenAICompatibleChat>[0]> = {}
) {
  return new OpenAICompatibleChat({
    ...extra,
    runtimeId: 'srv-abc123',
    baseUrl: BASE,
    label: 'llama box',
    product,
    fetch,
    hasCredentials: () => false,
    redact: text => text,
    ...(toolsChanged ? { toolsChanged } : {}),
  });
}

async function collect(client: OpenAICompatibleChat, request: Parameters<OpenAICompatibleChat['stream']>[0]) {
  const events: CompletionStreamEvent[] = [];
  await client.stream(request, event => events.push(event));
  return events;
}

const delta = (content: object, finish: string | null = null) => ({
  choices: [{ delta: content, finish_reason: finish }],
});

describe('OpenAICompatibleChat', () => {
  it('streams text, reasoning and usage, and sends the bare model name', async () => {
    const fetch = vi.fn<FetchLike>(async () =>
      sse([
        delta({ reasoning_content: 'thinking' }),
        delta({ content: 'Hel' }),
        delta({ content: 'lo' }, 'stop'),
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
        '[DONE]',
      ])
    );
    const events = await collect(chat(fetch), {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });
    expect(events).toEqual([
      { type: 'content', text: '<think>thinking</think>' },
      { type: 'content', text: 'Hel' },
      { type: 'content', text: 'lo' },
      { type: 'content', stopReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/chat/completions`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'qwen2.5-0.5b', stream: true, max_tokens: 64 });
  });

  it('assembles tool calls split across frames', async () => {
    const fetch: FetchLike = async () =>
      sse([
        delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] }, 'tool_calls'),
        '[DONE]',
      ]);
    const events = await collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'read a' }] });
    expect(events).toEqual([
      { type: 'tool_use', tools: [{ name: 'read_file', arguments: '{"path":"a"}', id: 'call_1' }] },
      { type: 'content', stopReason: 'tool_use' },
    ]);
  });

  it('reports a length stop as max_tokens', async () => {
    const fetch: FetchLike = async () => sse([delta({ content: 'cut' }, 'length'), '[DONE]']);
    const events = await collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    expect(events.at(-1)).toEqual({ type: 'content', stopReason: 'max_tokens' });
  });

  it("reports llama-server's timings as the rate", async () => {
    const fetch: FetchLike = async () =>
      sse([
        delta({ content: 'Hi' }, 'stop'),
        {
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
          timings: { prompt_n: 12, prompt_ms: 30, predicted_n: 3, predicted_ms: 120, draft_n: 4, draft_n_accepted: 2 },
        },
        '[DONE]',
      ]);
    const events = await collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    expect(events.at(-1)).toEqual({
      type: 'content',
      stopReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 },
      rate: { evalTokens: 3, evalMs: 120, promptTokens: 12, promptMs: 30, draftTokens: 4, draftAccepted: 2 },
    });
  });

  it("keeps llama-server's cache count from its timings over the usage details", async () => {
    const fetch: FetchLike = async () =>
      sse([
        delta({ content: 'Hi' }, 'stop'),
        {
          choices: [],
          usage: { prompt_tokens: 2500, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2000 } },
          timings: { cache_n: 2400, prompt_n: 100, prompt_ms: 50, predicted_n: 3, predicted_ms: 120 },
        },
        '[DONE]',
      ]);
    const events = await collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    expect(events.at(-1)).toEqual({
      type: 'content',
      stopReason: 'stop',
      usage: { inputTokens: 2500, outputTokens: 3 },
      rate: { evalTokens: 3, evalMs: 120, promptTokens: 100, promptMs: 50, cachedPromptTokens: 2400 },
    });
  });

  it('keeps the cached prompt count from the usage details on a reply too short to rate', async () => {
    const fetch: FetchLike = async () =>
      sse([
        delta({ content: 'Hi' }, 'stop'),
        {
          choices: [],
          usage: { prompt_tokens: 900, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 850 } },
        },
        '[DONE]',
      ]);
    const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    expect(events.at(-1)).toEqual({
      type: 'content',
      stopReason: 'stop',
      usage: { inputTokens: 900, outputTokens: 1, cachedPromptTokens: 850 },
    });
  });

  it('keeps the cached prompt count when a later usage chunk leaves the details out', async () => {
    const fetch: FetchLike = async () =>
      sse([
        delta({ content: 'Hi' }),
        {
          choices: [],
          usage: { prompt_tokens: 900, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 850 } },
        },
        delta({ content: '!' }, 'stop'),
        { choices: [], usage: { prompt_tokens: 900, completion_tokens: 2 } },
        '[DONE]',
      ]);
    const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 900, outputTokens: 2, cachedPromptTokens: 850 } });
  });

  it('keeps the reasoning count an OpenAI-compatible server reports', async () => {
    const fetch: FetchLike = async () =>
      sse([
        delta({ reasoning_content: 'hmm' }),
        delta({ content: 'Hi' }, 'stop'),
        {
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 25 } },
          timings: { predicted_n: 30, predicted_ms: 300 },
        },
        '[DONE]',
      ]);
    const events = await collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 20, outputTokens: 30, reasoningTokens: 25 } });
  });

  describe('without server timings', () => {
    /** One network read per group, each delivered with the clock at its `at`. */
    const reads = (...groups: { at: number; chunks: (object | string)[] }[]) => {
      const encoder = new TextEncoder();
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      let next = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const group = groups[next++];
            if (!group) return controller.close();
            clock = group.at;
            const text = group.chunks
              .map(chunk => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`)
              .join('');
            controller.enqueue(encoder.encode(text));
          },
        },
        { highWaterMark: 0 }
      );
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const ending = (completionTokens: number) => [
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: completionTokens } },
      '[DONE]',
    ];

    afterEach(() => vi.restoreAllMocks());

    it('estimates from the first streamed token to the last, and says so', async () => {
      const fetch: FetchLike = async () =>
        reads(
          { at: 1000, chunks: [delta({ content: 'a' })] },
          { at: 1500, chunks: [delta({ content: 'b' })] },
          { at: 3000, chunks: [delta({ content: 'c' }, 'stop'), ...ending(41)] }
        );
      const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      expect(events.at(-1)).toEqual({
        type: 'content',
        stopReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 41 },
        rate: { evalTokens: 40, evalMs: 2000, estimated: true },
      });
    });

    it("leaves the first read's tokens out of the estimate", async () => {
      const burst = Array.from({ length: 40 }, () => delta({ content: 'a' }));
      const fetch: FetchLike = async () =>
        reads(
          { at: 1000, chunks: burst },
          { at: 1500, chunks: [delta({ content: 'b' })] },
          { at: 3000, chunks: [delta({ content: 'c' }, 'stop'), ...ending(42)] }
        );
      const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      expect(events.at(-1)).toMatchObject({ rate: { evalTokens: 2, evalMs: 2000, estimated: true } });
    });

    it('estimates rather than take a server rate that timed nothing', async () => {
      const fetch: FetchLike = async () =>
        reads(
          { at: 1000, chunks: [delta({ content: 'a' })] },
          { at: 1500, chunks: [delta({ content: 'b' })] },
          {
            at: 3000,
            chunks: [
              delta({ content: 'c' }, 'stop'),
              {
                choices: [],
                usage: { prompt_tokens: 5, completion_tokens: 41 },
                timings: { predicted_n: 41, predicted_ms: 0 },
              },
              '[DONE]',
            ],
          }
        );
      const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      expect(events.at(-1)).toMatchObject({ rate: { evalTokens: 40, evalMs: 2000, estimated: true } });
    });

    it('keeps the cached prompt count from the usage details beside the estimate', async () => {
      const fetch: FetchLike = async () =>
        reads(
          { at: 1000, chunks: [delta({ content: 'a' })] },
          { at: 1500, chunks: [delta({ content: 'b' })] },
          {
            at: 3000,
            chunks: [
              delta({ content: 'c' }, 'stop'),
              {
                choices: [],
                usage: { prompt_tokens: 800, completion_tokens: 41, prompt_tokens_details: { cached_tokens: 600 } },
              },
              '[DONE]',
            ],
          }
        );
      const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      expect(events.at(-1)).toEqual({
        type: 'content',
        stopReason: 'stop',
        usage: { inputTokens: 800, outputTokens: 41, cachedPromptTokens: 600 },
        rate: { evalTokens: 40, evalMs: 2000, estimated: true },
      });
    });

    it('estimates nothing from a burst: a big first read and a few tiny ones right after', async () => {
      const fetch: FetchLike = async () =>
        reads(
          { at: 1000, chunks: Array.from({ length: 40 }, () => delta({ content: 'x' })) },
          { at: 1010, chunks: [delta({ content: 'y' })] },
          { at: 1020, chunks: [delta({ content: 'z' }, 'stop'), ...ending(42)] }
        );
      const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      expect(events.at(-1)).toEqual({
        type: 'content',
        stopReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 42 },
      });
    });

    it('estimates nothing from two reads, however far apart', async () => {
      const fetch: FetchLike = async () =>
        reads(
          { at: 1000, chunks: [delta({ content: 'a' })] },
          { at: 9000, chunks: [delta({ content: 'b' }, 'stop'), ...ending(30)] }
        );
      const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      expect(events.at(-1)).toEqual({
        type: 'content',
        stopReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 30 },
      });
    });

    it('estimates nothing from a reply that arrived in one read', async () => {
      const fetch: FetchLike = async () =>
        sse([delta({ content: 'abc' }, 'stop'), { choices: [], usage: { completion_tokens: 30 } }, '[DONE]']);
      const events = await collect(chat(fetch, null), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] });
      expect(events.at(-1)).toEqual({ type: 'content', stopReason: 'stop', usage: { outputTokens: 30 } });
    });
  });

  it('fails a reply that ends without finishing, naming the server', async () => {
    const fetch: FetchLike = async () => sse([delta({ content: 'half' })]);
    await expect(collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /llama box ended the reply/
    );
  });

  it('asks for new credentials on 401', async () => {
    const fetch: FetchLike = async () => new Response('{"error":"unauthorized"}', { status: 401 });
    await expect(
      collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toBeInstanceOf(ServerCredentialsError);
  });

  it('reports a 403 as a refusal, not as rejected credentials', async () => {
    const fetch: FetchLike = async () => new Response('', { status: 403 });
    await expect(
      collect(chat(fetch), { model: MODEL, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toBeInstanceOf(ServerForbiddenError);
  });

  it('retries without tools when the server refuses them, and remembers', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools) return new Response('{"error":{"message":"tools param requires --jinja flag"}}', { status: 500 });
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const client = chat(fetch);
    const request = {
      model: MODEL,
      messages: [{ role: 'user' as const, content: 'hi' }],
      tools: [{ toolSchema: { name: 'read_file', parameters: { type: 'object' } } }],
    };
    await collect(client, request);
    await collect(client, request);
    expect(bodies.map(body => 'tools' in body)).toEqual([true, false, false]);
    expect(client.toolsHint()).toMatch(/llama box refuses tool calls.*--jinja/);
  });

  it('does not probe a server that is not vLLM until it refuses tools', async () => {
    const fetch = vi.fn<FetchLike>();
    await chat(fetch).recheckTools('qwen2.5-0.5b');
    await chat(fetch, null).recheckTools('qwen2.5-0.5b');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a model id that belongs to another server', async () => {
    const fetch = vi.fn<FetchLike>();
    await expect(collect(chat(fetch), { model: 'local:srv-other:qwen', messages: [] })).rejects.toThrow(
      'Invalid local model id.'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads llama-server's context size from /props", async () => {
    const fetch: FetchLike = async url =>
      String(url).endsWith('/props')
        ? new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }), { status: 200 })
        : new Response('{}', { status: 404 });
    expect(await chat(fetch).contextTokens(MODEL)).toBe(8192);
    expect(await chat(fetch, null).contextTokens(MODEL)).toBe(16384);
  });

  it('lists models keyed by its server id', async () => {
    const fetch: FetchLike = async () =>
      new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'qwen2.5-0.5b', object: 'model', owned_by: 'llamacpp' }] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    const [model] = await chat(fetch).listModels();
    expect(model).toMatchObject({ id: MODEL, name: 'qwen2.5-0.5b' });
  });
});

describe('OpenAICompatibleChat generation settings', () => {
  const generation = { temperature: 0.3, topP: 0.85, topK: 25, minP: 0.04, repeatPenalty: 1.08, presencePenalty: 1.5 };

  function server(names: readonly string[] = ['qwen3-8b', 'gpt-oss-20b'], reasoning = false) {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return new Response(JSON.stringify({ object: 'list', data: names.map(id => ({ id, object: 'model' })) }));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([
        ...(reasoning ? [delta({ reasoning_content: 'hmm' })] : []),
        delta({ content: 'ok' }, 'stop'),
        '[DONE]',
      ]);
    });
    return { fetch, bodies };
  }

  const ask = (model: string, extra: Partial<Parameters<OpenAICompatibleChat['stream']>[0]> = {}) => ({
    model: `local:srv-abc123:${model}`,
    messages: [{ role: 'user' as const, content: 'hi' }],
    ...extra,
  });

  it.each([
    [
      'llama-server',
      { temperature: 0.3, top_p: 0.85, top_k: 25, repeat_penalty: 1.08, min_p: 0.04, presence_penalty: 1.5 },
    ],
    [
      'vllm',
      { temperature: 0.3, top_p: 0.85, top_k: 25, repetition_penalty: 1.08, min_p: 0.04, presence_penalty: 1.5 },
    ],
    ['lmstudio', { temperature: 0.3, top_p: 0.85, top_k: 25, repeat_penalty: 1.08, presence_penalty: 1.5 }],
    ['llama-swap', { temperature: 0.3, top_p: 0.85, presence_penalty: 1.5 }],
    [null, { temperature: 0.3, top_p: 0.85, presence_penalty: 1.5 }],
  ] as const)('sends the sampling fields %s takes', async (product, expected) => {
    const { fetch, bodies } = server();
    await collect(chat(fetch, product), ask('qwen3-8b', { generation }));
    const sampling = Object.fromEntries(
      Object.entries(bodies[0] ?? {}).filter(([key]) =>
        ['temperature', 'top_p', 'top_k', 'min_p', 'repeat_penalty', 'repetition_penalty', 'presence_penalty'].includes(
          key
        )
      )
    );
    expect(sampling).toEqual(expected);
  });

  it('sends no sampling or thinking field for an untouched conversation', async () => {
    const { fetch, bodies } = server();
    await collect(chat(fetch), ask('qwen3-8b', { thinking: true }));
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(['messages', 'model', 'stream', 'stream_options']);
  });

  it('turns thinking off through the chat template, and gives gpt-oss its effort level instead', async () => {
    const { fetch, bodies } = server();
    const client = chat(fetch, 'vllm');
    await collect(client, ask('qwen3-8b', { thinking: false }));
    await collect(client, ask('gpt-oss-20b', { thinking: false, reasoningEffort: 'high' }));
    await collect(client, ask('gpt-oss-20b', { reasoningEffort: 'xhigh' }));
    expect(bodies[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'high' });
    expect(bodies[1]).not.toHaveProperty('chat_template_kwargs');
    expect(bodies[2]).not.toHaveProperty('reasoning_effort');
  });

  it.each([
    ['llama-server', true],
    ['vllm', true],
    ['lmstudio', false],
    [null, false],
  ] as const)('sends the thinking switch only to a supported product: %s', async (product, supported) => {
    const { fetch, bodies } = server();
    const client = chat(fetch, product);
    for (const thinking of [undefined, true, false]) {
      await collect(client, ask('qwen3-8b', { thinking }));
    }
    expect(bodies[0]).not.toHaveProperty('chat_template_kwargs');
    expect(bodies[1]).not.toHaveProperty('chat_template_kwargs');
    if (supported) expect(bodies[2]).toHaveProperty('chat_template_kwargs', { enable_thinking: false });
    else expect(bodies[2]).not.toHaveProperty('chat_template_kwargs');
  });

  it.each(['lmstudio', null] as const)('does not offer an unsupported thinking switch on %s', async product => {
    const { fetch } = server(['qwen3-8b'], true);
    const client = chat(fetch, product);
    await collect(client, ask('qwen3-8b'));
    const [model] = await client.listModels();
    expect(model.thinkingToggle).toBeUndefined();
    expect(model.thinkingAlwaysOn).toBe(true);
  });

  it('runs a thinking-off turn on an unknown product without a chat_template_kwargs field', async () => {
    const { fetch: upstream } = server();
    const fetch: FetchLike = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if ('chat_template_kwargs' in body) {
        return Response.json(
          { error: { message: 'Unrecognized request argument: chat_template_kwargs' } },
          { status: 400 }
        );
      }
      return upstream(url, init);
    };
    await expect(collect(chat(fetch, null), ask('qwen3-8b', { thinking: false }))).resolves.toEqual(
      expect.arrayContaining([
        { type: 'content', text: 'ok' },
        { type: 'content', stopReason: 'stop' },
      ])
    );
  });

  it('sends enable_thinking only for thinking switched off, never for on or unset', async () => {
    const { fetch, bodies } = server();
    const client = chat(fetch);
    await collect(client, ask('qwen3-8b', { thinking: true }));
    await collect(client, ask('qwen3-8b'));
    expect(bodies[0]).not.toHaveProperty('chat_template_kwargs');
    expect(bodies[1]).not.toHaveProperty('chat_template_kwargs');
  });

  it('gives llama-server the gpt-oss level in the template kwargs too, which older builds read', async () => {
    const { fetch, bodies } = server();
    await collect(chat(fetch), ask('gpt-oss-20b', { reasoningEffort: 'low' }));
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' } });
  });

  it('finds gpt-oss behind a served name through a name that shares its weights', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'house-model', object: 'model', root: '/weights/oss' },
              { id: 'openai/gpt-oss-20b', object: 'model', root: '/weights/oss' },
            ],
          })
        );
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const client = chat(fetch, 'vllm');
    const [listed] = await client.listModels();
    expect(listed).toMatchObject({ name: 'house-model', supportsReasoningEffort: true });
    await collect(client, ask('house-model', { reasoningEffort: 'high' }));
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high' });
  });

  it('sends the gpt-oss level to a turn on a served name listed as its alias', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({
          object: 'list',
          data: [
            { id: 'openai/gpt-oss-20b', object: 'model', root: '/weights/oss' },
            { id: 'house-model', object: 'model', root: '/weights/oss' },
          ],
        });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const client = chat(fetch, 'vllm');
    expect((await client.listModels()).map(model => [model.name, model.aliasIds])).toEqual([
      ['openai/gpt-oss-20b', ['local:srv-abc123:house-model']],
    ]);
    await collect(client, ask('house-model', { reasoningEffort: 'medium' }));
    expect(bodies[0]).toMatchObject({ model: 'house-model', reasoning_effort: 'medium' });
  });

  it('lists a thinking switch learned on an earlier run, and saves one learned now', async () => {
    const { fetch } = server(['qwen3-8b', 'phi-4'], true);
    const add = vi.fn(async () => undefined);
    const client = new OpenAICompatibleChat({
      runtimeId: 'srv-abc123',
      baseUrl: BASE,
      label: 'llama box',
      product: 'vllm',
      fetch,
      hasCredentials: () => false,
      redact: text => text,
      learnedThinkers: { read: async () => [{ model: 'qwen3-8b' }], add, forget: vi.fn() },
    });
    expect((await client.listModels()).map(model => [model.name, model.thinkingToggle])).toEqual([
      ['qwen3-8b', true],
      ['phi-4', undefined],
    ]);
    await collect(client, ask('qwen3-8b'));
    expect(add).not.toHaveBeenCalled();
    await collect(client, ask('phi-4'));
    expect(add).toHaveBeenCalledWith('phi-4', undefined);
  });

  it('reads the learned thinking switches again after a failed read', async () => {
    const { fetch } = server(['qwen3-8b'], true);
    const read = vi
      .fn<() => Promise<LearnedThinker[]>>()
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValue([{ model: 'qwen3-8b' }]);
    const client = new OpenAICompatibleChat({
      runtimeId: 'srv-abc123',
      baseUrl: BASE,
      label: 'llama box',
      product: 'vllm',
      fetch,
      hasCredentials: () => false,
      redact: text => text,
      learnedThinkers: { read, add: vi.fn(), forget: vi.fn() },
    });
    expect((await client.listModels())[0].thinkingToggle).toBeUndefined();
    expect((await client.listModels())[0].thinkingToggle).toBe(true);
    await client.listModels();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('forgets a learned thinking switch once other weights are served under its name', async () => {
    let size = 4_000_000_000;
    const fetch: FetchLike = async url => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'house', object: 'model', meta: { size } }] });
      return sse([delta({ reasoning_content: 'hmm' }), delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const add = vi.fn(async (_model: string, _identity: string | undefined) => undefined);
    const forget = vi.fn(async (_model: string) => undefined);
    const open = (read: LearnedThinker[]) =>
      new OpenAICompatibleChat({
        runtimeId: 'srv-abc123',
        baseUrl: BASE,
        label: 'llama box',
        product: 'llama-server',
        fetch,
        hasCredentials: () => false,
        redact: text => text,
        learnedThinkers: { read: async () => read, add, forget },
      });
    const client = open([]);
    await client.listModels();
    await collect(client, ask('house'));
    const identity = add.mock.calls[0]?.[1];
    expect(add).toHaveBeenCalledWith('house', expect.any(String));
    expect((await client.listModels())[0]?.thinkingToggle).toBe(true);
    expect((await open([{ model: 'house', identity }]).listModels())[0]?.thinkingToggle).toBe(true);

    size = 8_000_000_000;
    expect((await client.listModels())[0]?.thinkingToggle).toBeUndefined();
    expect(forget).toHaveBeenCalledWith('house');
    forget.mockClear();
    expect((await open([{ model: 'house', identity }]).listModels())[0]?.thinkingToggle).toBeUndefined();
    expect(forget).toHaveBeenCalledWith('house');
    expect((await open([{ model: 'house' }]).listModels())[0]?.thinkingToggle).toBe(true);
  });

  it('gives a thinker stored without an identity the listed weights, and forgets it when they change', async () => {
    let size = 4_000_000_000;
    const fetch: FetchLike = async url => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'house', object: 'model', meta: { size } }] });
      return sse([delta({ reasoning_content: 'hmm' }), delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const add = vi.fn(async (_model: string, _identity: string | undefined) => undefined);
    const forget = vi.fn(async (_model: string) => undefined);
    const changed = vi.fn();
    const client = new OpenAICompatibleChat({
      runtimeId: 'srv-abc123',
      baseUrl: BASE,
      label: 'llama box',
      product: 'llama-server',
      fetch,
      hasCredentials: () => false,
      redact: text => text,
      toolsChanged: changed,
      learnedThinkers: { read: async () => [{ model: 'house' }], add, forget },
    });
    expect((await client.listModels())[0]?.thinkingToggle).toBe(true);
    expect(add).toHaveBeenCalledExactlyOnceWith('house', expect.any(String));
    await collect(client, ask('house'));
    expect(add).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();

    size = 8_000_000_000;
    expect((await client.listModels())[0]?.thinkingToggle).toBeUndefined();
    expect(forget).toHaveBeenCalledWith('house');
  });

  it('keeps a learned thinker when a listing says nothing about the weights', async () => {
    let meta: { size: number } | null = { size: 4_000_000_000 };
    const fetch: FetchLike = async url => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'house', object: 'model', meta }] });
      return sse([delta({ reasoning_content: 'hmm' }), delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const add = vi.fn(async (_model: string, _identity: string | undefined) => undefined);
    const forget = vi.fn(async (_model: string) => undefined);
    const client = new OpenAICompatibleChat({
      runtimeId: 'srv-abc123',
      baseUrl: BASE,
      label: 'llama box',
      product: 'llama-server',
      fetch,
      hasCredentials: () => false,
      redact: text => text,
      learnedThinkers: { read: async () => [], add, forget },
    });
    await client.listModels();
    await collect(client, ask('house'));
    expect(add).toHaveBeenCalledWith('house', expect.any(String));

    meta = null;
    expect((await client.listModels())[0]?.thinkingToggle).toBe(true);
    expect(forget).not.toHaveBeenCalled();
  });

  it('lists a thinking switch for a model once it has replied with reasoning, and effort levels for gpt-oss', async () => {
    const { fetch } = server(['qwen3-8b', 'gpt-oss-20b'], true);
    const changed = vi.fn();
    const client = chat(fetch, 'vllm', changed);
    const before = await client.listModels();
    expect(before.map(model => [model.name, model.thinkingToggle, model.supportsReasoningEffort])).toEqual([
      ['qwen3-8b', undefined, false],
      ['gpt-oss-20b', undefined, true],
    ]);
    expect(before[1]?.controls?.effort?.levels).toEqual(['low', 'medium', 'high']);
    expect(before[0]?.controls).toMatchObject({ topK: {}, minP: {}, repeatPenalty: {} });

    await collect(client, ask('qwen3-8b'));
    await collect(client, ask('qwen3-8b'));
    await collect(client, ask('gpt-oss-20b'));
    expect(changed).toHaveBeenCalledTimes(2);
    const after = await client.listModels();
    // gpt-oss reasons on every reply but cannot stop, so it keeps its levels and gets no switch.
    expect(after.map(model => [model.name, model.thinkingToggle, model.minimalThinks])).toEqual([
      ['qwen3-8b', true, true],
      ['gpt-oss-20b', undefined, undefined],
    ]);
  });
});

describe('OpenAICompatibleChat gpt-oss by its template', () => {
  const HARMONY =
    '{%- if reasoning_effort is not defined %}{%- set reasoning_effort = "medium" %}{%- endif %}' +
    '<|start|>system<|message|>Reasoning: {{ reasoning_effort }}<|end|>' +
    '{{- "<|start|>assistant<|channel|>analysis<|message|>" }}';
  const QWEN =
    '{%- if enable_thinking is defined and enable_thinking is false %}<think>\n\n</think>{%- endif %}<|im_start|>';
  const CHANNEL_ONLY = '<|start|>assistant<|channel|>final<|message|>';
  const EFFORT_ONLY = '{{ reasoning_effort }}<|im_start|>assistant';

  type PropsAnswer = () => Response | Promise<Response>;

  /** A llama-server whose `/props` answers with `props`; chat replies reason when `reasoning` is set. */
  function llamaServer(options: {
    names?: () => string[];
    size?: () => number | null;
    /** A router's `status.value` by name; a name left out carries no status, as on a single-model server. */
    states?: () => Record<string, string>;
    props: PropsAnswer;
    /** Extra fields on a listed entry, such as a shared `root` that makes names aliases of one model. */
    fields?: (id: string) => Record<string, unknown>;
    /** Throws for a listing, as an unreachable server does. */
    down?: () => boolean;
  }) {
    const bodies: Record<string, unknown>[] = [];
    const propsUrls: string[] = [];
    const names = options.names ?? (() => ['house-model']);
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/v1/models')) {
        if (options.down?.()) throw new TypeError('fetch failed');
        const size = options.size?.();
        const states = options.states?.() ?? {};
        return Response.json({
          object: 'list',
          data: names().map(id => ({
            id,
            object: 'model',
            ...(size === undefined ? {} : { meta: size && { size } }),
            ...(Object.hasOwn(states, id) ? { status: { value: states[id] } } : {}),
            ...(options.fields?.(id) ?? {}),
          })),
        });
      }
      if (path.startsWith(`${BASE}/props`)) {
        propsUrls.push(path);
        return options.props();
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    });
    return { fetch, bodies, propsUrls };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Drives performance.now, which the retry spacing reads, from `set`; offsets are from the start of the test. */
  function fakeClock() {
    let offset = 0;
    const base = performance.now();
    vi.spyOn(performance, 'now').mockImplementation(() => base + offset);
    return { set: (ms: number) => void (offset = ms) };
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const notLoaded = () => Response.json({ error: { code: 400, message: 'model is not loaded' } }, { status: 400 });
  const template = (chat_template: unknown, model_path?: string) => () =>
    Response.json({ chat_template, ...(model_path ? { model_path } : {}) });
  const ask = (model: string, extra: Partial<Parameters<OpenAICompatibleChat['stream']>[0]> = {}) => ({
    model: `local:srv-abc123:${model}`,
    messages: [{ role: 'user' as const, content: 'hi' }],
    ...extra,
  });
  const effortOf = async (client: OpenAICompatibleChat) =>
    (await client.listModels()).map(model => [model.name, model.supportsReasoningEffort, model.thinkingToggle]);

  it.each([
    ['the gpt-oss harmony template', HARMONY, true],
    ['a Qwen template', QWEN, false],
    ['harmony channels without reasoning_effort', CHANNEL_ONLY, false],
    ['reasoning_effort without harmony channels', EFFORT_ONLY, false],
    ['an empty template', '', false],
  ])('reads %s as taking effort levels: %s', (_label, text, expected) => {
    expect(isEffortTemplate(text)).toBe(expected);
  });

  it('gives a model served under any name effort levels once its template is the gpt-oss one', async () => {
    const server = llamaServer({ props: template(HARMONY) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const [listed] = await client.listModels();
    expect(listed).toMatchObject({ name: 'house-model', supportsReasoningEffort: true });
    expect(listed?.controls?.effort?.levels).toEqual(['low', 'medium', 'high']);
    expect(listed?.thinkingToggle).toBeUndefined();

    await collect(client, ask('house-model', { thinking: false, reasoningEffort: 'high' }));
    expect(server.bodies[0]).toMatchObject({
      reasoning_effort: 'high',
      chat_template_kwargs: { reasoning_effort: 'high' },
    });
    expect(server.bodies[0]?.chat_template_kwargs).not.toHaveProperty('enable_thinking');
    expect(server.propsUrls).toEqual([`${BASE}/props?model=house-model&autoload=false`]);
    expect(changed).toHaveBeenCalledOnce();
  });

  it.each([
    ['a Qwen template', QWEN],
    ['harmony channels without reasoning_effort', CHANNEL_ONLY],
    ['reasoning_effort without harmony channels', EFFORT_ONLY],
    ['an empty template', ''],
  ])('keeps %s as known, with no effort levels and no second ask', async (_label, text) => {
    const server = llamaServer({ props: template(text) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await collect(client, ask('house-model', { thinking: false, reasoningEffort: 'high' }));
    expect(server.bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(server.bodies[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(server.propsUrls).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('asks a router again once a reply has loaded a model it could not answer for', async () => {
    let loaded = false;
    const server = llamaServer({
      names: () => ['org/gpt oss:Q4'],
      props: () =>
        loaded
          ? Response.json({ chat_template: HARMONY })
          : Response.json({ error: { code: 400, message: 'model is not loaded' } }, { status: 400 }),
    });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await effortOf(client)).toEqual([['org/gpt oss:Q4', false, undefined]]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(server.propsUrls).toEqual([`${BASE}/props?model=org%2Fgpt%20oss%3AQ4&autoload=false`]);
    expect(changed).not.toHaveBeenCalled();

    loaded = true;
    await collect(client, ask('org/gpt oss:Q4'));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(server.propsUrls).toHaveLength(2);
    expect(await effortOf(client)).toEqual([['org/gpt oss:Q4', true, undefined]]);
    await collect(client, ask('org/gpt oss:Q4', { reasoningEffort: 'low' }));
    expect(server.bodies[1]).toMatchObject({ reasoning_effort: 'low' });
  });

  it.each([
    ['a refused connection', () => Promise.reject(new TypeError('fetch failed'))],
    ['a server error', () => new Response('boom', { status: 500 })],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['JSON without a template', () => Response.json({ default_generation_settings: { n_ctx: 4096 } })],
    ['a template that is not text', template(42)],
    ['a null body', () => Response.json(null)],
  ] satisfies [string, PropsAnswer][])('lists the model and asks again a while after %s', async (_label, props) => {
    const clock = fakeClock();
    const server = llamaServer({ props });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await settle();
    clock.set(TEMPLATE_RETRY_MS - 1);
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await settle();
    expect(server.propsUrls).toHaveLength(1);
    clock.set(TEMPLATE_RETRY_MS);
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
    expect(changed).not.toHaveBeenCalled();
  });

  it('spaces retries by the monotonic clock, so a wall-clock jump back does not stall them', async () => {
    const clock = fakeClock();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const server = llamaServer({ props: () => new Response('boom', { status: 500 }) });
    const client = chat(server.fetch);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await settle();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    clock.set(TEMPLATE_RETRY_MS);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
  });

  it.each(['vllm', 'lmstudio', 'llama-swap', null] as const)('never asks %s for a template', async product => {
    const server = llamaServer({ props: template(HARMONY) });
    const client = chat(server.fetch, product);
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await collect(client, ask('house-model'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(server.propsUrls).toEqual([]);
  });

  it('lists without waiting for the template and asks once while the answer is out', async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = llamaServer({ props: () => new Promise<Response>(resolve => (answer = resolve)) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await collect(client, ask('house-model'));
    expect(server.propsUrls).toHaveLength(1);
    answer(Response.json({ chat_template: HARMONY }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    // A turn sent before the next listing already carries the level.
    await collect(client, ask('house-model', { reasoningEffort: 'medium' }));
    expect(server.bodies[1]).toMatchObject({ reasoning_effort: 'medium' });
    expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
  });

  it('asks again once other weights take the name, and keeps the answer when a listing names no weights', async () => {
    let size: number | null = 12_000_000_000;
    let text = HARMONY;
    const server = llamaServer({ size: () => size, props: () => Response.json({ chat_template: text }) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());

    size = null;
    expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
    size = 12_000_000_000;
    expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
    expect(server.propsUrls).toHaveLength(1);

    size = 5_000_000_000;
    text = QWEN;
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    expect(server.propsUrls).toHaveLength(2);
  });

  it('asks again for a name that left the listing and came back', async () => {
    let names = ['house-model'];
    const server = llamaServer({ names: () => names, props: template(HARMONY) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    names = ['other'];
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
    names = ['house-model'];
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3));
    expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
  });

  it.each([
    { oldTemplate: HARMONY, currentTemplate: QWEN, effort: false },
    { oldTemplate: QWEN, currentTemplate: HARMONY, effort: true },
  ])(
    'discards the old template when a returning model takes effort=$effort',
    async ({ oldTemplate, currentTemplate, effort }) => {
      let names = ['house-model'];
      const answers: ((response: Response) => void)[] = [];
      const server = llamaServer({
        names: () => names,
        props: () => new Promise<Response>(resolve => answers.push(resolve)),
      });
      const changed = vi.fn();
      const client = chat(server.fetch, 'llama-server', changed);
      await client.listModels();
      await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));

      names = [];
      expect(await effortOf(client)).toEqual([]);
      names = ['house-model'];
      expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);

      answers[0](Response.json({ chat_template: oldTemplate }));
      await settle();
      expect(changed).not.toHaveBeenCalled();
      expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1](Response.json({ chat_template: currentTemplate }));
      await settle();
      expect(await effortOf(client)).toEqual([['house-model', effort, undefined]]);
      expect(changed).toHaveBeenCalledTimes(effort ? 1 : 0);
    }
  );

  it('asks at once for a name it got no template for once it has left the listing and come back', async () => {
    let names = ['house-model'];
    const server = llamaServer({ names: () => names, props: () => new Response('boom', { status: 500 }) });
    const client = chat(server.fetch, 'llama-server');
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    names = ['other'];
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    names = ['house-model'];
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(3));
    expect(server.propsUrls.map(url => new URL(url).searchParams.get('model'))).toEqual([
      'house-model',
      'other',
      'house-model',
    ]);
  });

  const probed = (urls: string[]) => urls.map(url => new URL(url).searchParams.get('model'));
  const sharedRoot = () => ({ root: 'one-set-of-weights' });

  describe('on a router', () => {
    it('asks only models that are loaded, sleeping or carry no status, two at a time', async () => {
      let active = 0;
      let most = 0;
      const server = llamaServer({
        names: () => ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'],
        states: () => ({ m0: 'loaded', m1: 'loaded', m2: 'unloaded', m3: 'sleeping', m4: 'loading', m5: 'loaded' }),
        props: async () => {
          active++;
          most = Math.max(most, active);
          await settle();
          active--;
          return Response.json({ chat_template: QWEN });
        },
      });
      const client = chat(server.fetch);
      await client.listModels();
      await vi.waitFor(() => expect(server.propsUrls).toHaveLength(5));
      await settle();
      expect(probed(server.propsUrls).sort()).toEqual(['m0', 'm1', 'm3', 'm5', 'm6']);
      expect(most).toBe(PROPS_CONCURRENCY);
    });

    it('does not ask a model that is unloaded at listing, and asks once it is loaded with other weights', async () => {
      let state = 'unloaded';
      let size = 12_000_000_000;
      const server = llamaServer({
        size: () => size,
        states: () => ({ 'house-model': state }),
        props: template(HARMONY),
      });
      const changed = vi.fn();
      const client = chat(server.fetch, 'llama-server', changed);
      expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
      await settle();
      expect(server.propsUrls).toEqual([]);

      state = 'loaded';
      size = 5_000_000_000;
      await client.listModels();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
    });

    it('asks again at once when other weights take the name of a model that was not loaded', async () => {
      let size = 12_000_000_000;
      let answer: PropsAnswer = notLoaded;
      const server = llamaServer({
        size: () => size,
        states: () => ({ 'house-model': 'loaded' }),
        props: () => answer(),
      });
      const changed = vi.fn();
      const client = chat(server.fetch, 'llama-server', changed);
      await client.listModels();
      await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
      await settle();
      await client.listModels();
      await settle();
      expect(server.propsUrls).toHaveLength(1);

      size = 5_000_000_000;
      answer = template(HARMONY);
      await client.listModels();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(server.propsUrls).toHaveLength(2);
    });

    it('drops an answer that was out when other weights took the name', async () => {
      let size = 12_000_000_000;
      let answer: (response: Response) => void = () => undefined;
      const server = llamaServer({
        size: () => size,
        props: () => new Promise<Response>(resolve => (answer = resolve)),
      });
      const changed = vi.fn();
      const client = chat(server.fetch, 'llama-server', changed);
      await client.listModels();
      await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
      size = 5_000_000_000;
      await client.listModels();
      answer(Response.json({ chat_template: HARMONY }));
      await settle();
      expect(changed).not.toHaveBeenCalled();
      expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    });

    it('keeps a template when a model is loaded again from the same file, and drops it for another file', async () => {
      let state = 'loaded';
      let answer: PropsAnswer = template(HARMONY, '/models/a.gguf');
      const server = llamaServer({
        size: () => 12_000_000_000,
        states: () => ({ 'house-model': state }),
        props: () => answer(),
      });
      const changed = vi.fn();
      const client = chat(server.fetch, 'llama-server', changed);
      await client.listModels();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());

      state = 'unloaded';
      await client.listModels();
      await settle();
      expect(server.propsUrls).toHaveLength(1);

      state = 'loaded';
      answer = template(QWEN, '/models/a.gguf');
      await client.listModels();
      await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
      await settle();
      expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
      expect(changed).toHaveBeenCalledOnce();

      state = 'unloaded';
      await client.listModels();
      state = 'loaded';
      answer = template(QWEN, '/models/b.gguf');
      await client.listModels();
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
      expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    });

    it('reads the template under the listed name when a reply came through an alias', async () => {
      let loaded = false;
      const server = llamaServer({
        names: () => ['alpha', 'beta'],
        fields: sharedRoot,
        props: () => (loaded ? Response.json({ chat_template: HARMONY }) : notLoaded()),
      });
      const changed = vi.fn();
      const client = chat(server.fetch, 'llama-server', changed);
      await client.listModels();
      await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
      await settle();
      loaded = true;
      await collect(client, ask('beta'));
      await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
      expect(probed(server.propsUrls)).toEqual(['alpha', 'alpha']);
      expect(await effortOf(client)).toEqual([['alpha', true, undefined]]);
    });
  });

  it('gives a turn through an alias the effort level once the listed name has a template, before the next listing', async () => {
    const server = llamaServer({ names: () => ['alpha', 'beta'], fields: sharedRoot, props: template(HARMONY) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await collect(client, ask('beta', { reasoningEffort: 'high' }));
    expect(server.bodies[0]).toMatchObject({ reasoning_effort: 'high' });
    expect(probed(server.propsUrls)).toEqual(['alpha']);
  });

  it.each([404, 405])('stops asking a server that answers %s for /props, across models and replies', async status => {
    const server = llamaServer({
      names: () => ['m0', 'm1', 'm2', 'm3', 'm4'],
      props: () => new Response('', { status }),
    });
    const client = chat(server.fetch);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(PROPS_CONCURRENCY));
    await settle();
    for (const model of ['m0', 'm1', 'm0']) await collect(client, ask(model));
    await client.listModels();
    await settle();
    expect(server.propsUrls).toHaveLength(PROPS_CONCURRENCY);
  });

  it('probes /props again once the 404 expires, and not before', async () => {
    const clock = fakeClock();
    let status = 404;
    const changed = vi.fn();
    const server = llamaServer({
      props: () => (status === 404 ? new Response('', { status }) : Response.json({ chat_template: HARMONY })),
    });
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await settle();
    clock.set(NO_PROPS_EXPIRY_MS - 1);
    await collect(client, ask('house-model'));
    await client.listModels();
    await settle();
    expect(server.propsUrls).toHaveLength(1);

    status = 200;
    clock.set(NO_PROPS_EXPIRY_MS);
    await client.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(server.propsUrls).toHaveLength(2);
  });

  it('asks again after a restart for a server that had no /props, and keeps asking once it has one', async () => {
    let down = false;
    let status = 404;
    const server = llamaServer({
      down: () => down,
      props: () => (status === 404 ? new Response('', { status }) : Response.json({ chat_template: HARMONY })),
    });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await settle();
    await collect(client, ask('house-model'));
    expect(server.propsUrls).toHaveLength(1);

    down = true;
    await expect(client.listModels()).rejects.toThrow();
    down = false;
    status = 200;
    await client.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(server.propsUrls).toHaveLength(2);
  });

  it('does not ask again after a reply when the last ask failed for a reason other than not being loaded', async () => {
    const server = llamaServer({ props: () => new Response('boom', { status: 500 }) });
    const client = chat(server.fetch);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await settle();
    for (let turn = 0; turn < 3; turn++) await collect(client, ask('house-model'));
    await settle();
    expect(server.propsUrls).toHaveLength(1);
  });

  it('asks again after every reply while a router says the model is not loaded', async () => {
    const server = llamaServer({ props: notLoaded });
    const client = chat(server.fetch);
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    await settle();
    await collect(client, ask('house-model'));
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
    await settle();
    await collect(client, ask('house-model'));
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(3));
  });

  it('never asks about a model whose name or alias already says gpt-oss', async () => {
    const server = llamaServer({
      names: () => ['gpt-oss-20b', 'house', 'my-gpt-oss'],
      fields: id => (id === 'gpt-oss-20b' ? {} : sharedRoot()),
      props: template(QWEN),
    });
    const client = chat(server.fetch);
    expect(await effortOf(client)).toEqual([
      ['gpt-oss-20b', true, undefined],
      ['house', true, undefined],
    ]);
    for (const model of ['gpt-oss-20b', 'house', 'my-gpt-oss']) await collect(client, ask(model));
    await settle();
    expect(server.propsUrls).toEqual([]);
    expect(await effortOf(client)).toEqual([
      ['gpt-oss-20b', true, undefined],
      ['house', true, undefined],
    ]);
  });

  it('does nothing when its server was replaced or removed while an ask was out', async () => {
    let current = true;
    let answer: (response: Response) => void = () => undefined;
    const server = llamaServer({ props: () => new Promise<Response>(resolve => (answer = resolve)) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed, { isCurrent: () => current });
    await client.listModels();
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(1));
    current = false;
    answer(Response.json({ chat_template: HARMONY }));
    await settle();
    expect(changed).not.toHaveBeenCalled();
  });

  it('sends no queued ask once its server was replaced or removed', async () => {
    let current = true;
    const answers: ((response: Response) => void)[] = [];
    const server = llamaServer({
      names: () => ['m0', 'm1', 'm2', 'm3'],
      props: () => new Promise<Response>(resolve => answers.push(resolve)),
    });
    const client = chat(server.fetch, 'llama-server', undefined, { isCurrent: () => current });
    await client.listModels();
    await vi.waitFor(() => expect(answers).toHaveLength(PROPS_CONCURRENCY));
    current = false;
    for (const answer of answers) answer(Response.json({ chat_template: QWEN }));
    await settle();
    expect(server.propsUrls).toHaveLength(PROPS_CONCURRENCY);
  });

  it('forgets every template after a failed listing, in case the server restarted with another one', async () => {
    let down = false;
    let text = HARMONY;
    const server = llamaServer({ down: () => down, props: () => Response.json({ chat_template: text }) });
    const changed = vi.fn();
    const client = chat(server.fetch, 'llama-server', changed);
    await client.listModels();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());

    expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
    expect(server.propsUrls).toHaveLength(1);

    down = true;
    await expect(client.listModels()).rejects.toThrow();
    await expect(client.listModels()).rejects.toThrow();
    down = false;
    text = QWEN;
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    await vi.waitFor(() => expect(server.propsUrls).toHaveLength(2));
    await settle();
    expect(await effortOf(client)).toEqual([['house-model', false, undefined]]);
    expect(server.propsUrls).toHaveLength(2);
  });

  it('warns and carries on when the model list change callback throws', async () => {
    const server = llamaServer({ props: template(HARMONY) });
    const warn = vi.fn();
    const toolsChanged = vi.fn(() => {
      throw new Error('registry gone');
    });
    const client = chat(server.fetch, 'llama-server', toolsChanged, { warn });
    await client.listModels();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn.mock.calls[0]?.[0]).toContain('registry gone');
    expect(await effortOf(client)).toEqual([['house-model', true, undefined]]);
  });
});

describe('OpenAICompatibleChat on a server that fronts several models', () => {
  const MODEL_A = 'local:srv-abc123:a';
  const MODEL_B = 'local:srv-abc123:b';
  const tools = [{ toolSchema: { name: 'read_file', parameters: { type: 'object' } } }];
  const ask = (model: string) => ({ model, messages: [{ role: 'user' as const, content: 'hi' }], tools });

  function proxy(maxModelLen?: number) {
    const bodies: Record<string, unknown>[] = [];
    let listings = 0;
    let refuseA = true;
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models')) {
        listings += 1;
        const entry = (name: string) => ({
          id: name,
          object: 'model',
          ...(maxModelLen ? { max_model_len: maxModelLen } : {}),
        });
        return new Response(JSON.stringify({ object: 'list', data: [entry('a'), entry('b')] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools && body.model === 'a' && refuseA)
        return new Response('{"error":{"message":"tools param requires --jinja flag"}}', { status: 500 });
      return body.stream
        ? sse([delta({ content: 'ok' }, 'stop'), '[DONE]'])
        : new Response(JSON.stringify({ choices: [{ message: { content: 'p' } }] }), { status: 200 });
    };
    return { fetch, bodies, listings: () => listings, acceptA: () => (refuseA = false) };
  }

  it('turns tools off only for the model that refused them, and probes that model on a recheck', async () => {
    const server = proxy();
    const client = chat(server.fetch, null);
    await collect(client, ask(MODEL_A));
    await collect(client, ask(MODEL_B));
    expect(server.bodies.map(body => [body.model, 'tools' in body])).toEqual([
      ['a', true],
      ['a', false],
      ['b', true],
    ]);
    expect((await client.listModels()).map(model => [model.name, model.supportsTools])).toEqual([
      ['a', false],
      ['b', undefined],
    ]);

    server.acceptA();
    await client.recheckTools('b');
    expect(server.bodies.at(-1)).toMatchObject({ model: 'a', max_tokens: 1 });
    expect(client.toolsHint()).toBeNull();
  });

  it('asks a server that lists no context once, not on every turn', async () => {
    const server = proxy();
    const client = chat(server.fetch, null);
    await client.contextTokens(MODEL_A);
    await client.contextTokens(MODEL_A);
    expect(server.listings()).toBe(1);
  });

  describe("with a model's own context from the Models screen", () => {
    const budgeted = (fetch: FetchLike) =>
      new OpenAICompatibleChat({
        runtimeId: 'srv-abc123',
        baseUrl: BASE,
        label: 'vllm box',
        product: 'vllm',
        fetch,
        hasCredentials: () => false,
        redact: text => text,
        loadSettings: async modelId =>
          modelId === MODEL_A ? { context: { mode: 'fixed', tokens: 32768 }, draftTokens: 3, keepAlive: -1 } : {},
      });

    it('compacts against a smaller size as a budget, lists it, and sends no Ollama-only field', async () => {
      const server = proxy(65536);
      const client = budgeted(server.fetch);
      expect((await client.listModels()).map(model => [model.name, model.contextWindow, model.contextFixed])).toEqual([
        ['a', 32768, true],
        ['b', 65536, true],
      ]);
      expect(await client.contextTokens(MODEL_A)).toBe(32768);
      expect(await client.contextTokens(MODEL_B)).toBe(65536);
      await collect(client, { model: MODEL_A, messages: [{ role: 'user', content: 'hi' }] });
      expect(server.bodies.at(-1)).not.toHaveProperty('keep_alive');
      expect(JSON.stringify(server.bodies.at(-1))).not.toContain('draft');
    });

    it('applies a model budget to a request that names it by an alias', async () => {
      const entry = (id: string) => ({ id, object: 'model', root: '/models/a', max_model_len: 65536 });
      const fetch: FetchLike = async () =>
        new Response(JSON.stringify({ object: 'list', data: [entry('a'), entry('a-alias')] }), { status: 200 });
      const client = budgeted(fetch);
      await client.listModels();
      expect(await client.contextTokens('local:srv-abc123:a-alias')).toBe(32768);
    });

    it('forgets an alias mapping when that name becomes a separately listed model', async () => {
      const entry = (id: string, root: string) => ({ id, root, object: 'model', max_model_len: 65536 });
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(
          Response.json({ object: 'list', data: [entry('a', '/models/a'), entry('b', '/models/a')] })
        )
        .mockResolvedValueOnce(Response.json({ object: 'list', data: [entry('b', '/models/b')] }));
      const client = budgeted(fetch);
      await client.listModels();
      expect(await client.contextTokens(MODEL_B)).toBe(32768);
      expect((await client.listModels())[0]?.contextWindow).toBe(65536);
      expect(await client.contextTokens(MODEL_B)).toBe(65536);
    });

    it('rejects an unreadable budget and retries instead of treating it as unset', async () => {
      const read = vi
        .fn<() => Promise<ModelLoadSettings>>()
        .mockRejectedValueOnce(new Error('settings unavailable'))
        .mockResolvedValue({ context: { mode: 'fixed', tokens: 32768 } });
      const client = new OpenAICompatibleChat({
        runtimeId: 'srv-abc123',
        baseUrl: BASE,
        label: 'vllm box',
        product: 'vllm',
        fetch: proxy(65536).fetch,
        hasCredentials: () => false,
        redact: text => text,
        loadSettings: read,
      });
      await expect(client.contextTokens(MODEL_A)).rejects.toThrow('settings unavailable');
      expect(await client.contextTokens(MODEL_A)).toBe(32768);
    });

    it('lists the server at its served context while the settings cannot be read, and still rejects the budget', async () => {
      const unreadable = 'The model settings file /data/model-settings.json is not valid JSON.';
      const client = new OpenAICompatibleChat({
        runtimeId: 'srv-abc123',
        baseUrl: BASE,
        label: 'vllm box',
        product: 'vllm',
        fetch: proxy(65536).fetch,
        hasCredentials: () => false,
        redact: text => text,
        loadSettings: () => Promise.reject(new Error(unreadable)),
      });
      expect((await client.listModels()).map(model => [model.name, model.contextWindow])).toEqual([
        ['a', 65536],
        ['b', 65536],
      ]);
      await expect(client.contextTokens(MODEL_A)).rejects.toThrow(unreadable);
    });

    it('offers only sizes below what the server runs, and nothing when it does not say', async () => {
      expect(await budgeted(proxy(65536).fetch).loadOffer(MODEL_A)).toEqual({
        context: { kind: 'budget', server: 65536, sizes: [16384, 32768] },
      });
      expect(await budgeted(proxy(16384).fetch).loadOffer(MODEL_A)).toEqual({});
      expect(await budgeted(proxy().fetch).loadOffer(MODEL_A)).toEqual({});
    });
  });
});

describe('OpenAICompatibleChat max output on a context the server fixes', () => {
  const CONTEXT = 8192;
  const ask = (chars: number, maxTokens?: number) => ({
    model: 'local:srv-abc123:qwen3-8b',
    messages: [{ role: 'user' as const, content: 'x'.repeat(chars) }],
    ...(maxTokens ? { maxTokens } : {}),
  });

  /** vLLM: refuses prompt + max_tokens past max_model_len, counting `charsPerToken` characters a token. */
  function vllm(charsPerToken: number, maxModelLen = CONTEXT) {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({
          object: 'list',
          data: [{ id: 'qwen3-8b', object: 'model', ...(maxModelLen ? { max_model_len: maxModelLen } : {}) }],
        });
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number; messages: { content: string }[] };
      bodies.push(body as unknown as Record<string, unknown>);
      const prompt = Math.ceil(body.messages[0].content.length / charsPerToken);
      if (maxModelLen && body.max_tokens && prompt + body.max_tokens > maxModelLen)
        return Response.json(
          {
            error: {
              message: `This model's maximum context length is ${maxModelLen} tokens. However, you requested ${prompt + body.max_tokens} tokens.`,
            },
          },
          { status: 400 }
        );
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    return { fetch, bodies };
  }

  it('keeps a limit that fits, lowers one that does not, and sends the cap, then the room the server counts, when the estimate leaves none', async () => {
    const server = vllm(4);
    const client = chat(server.fetch, 'vllm');
    await client.listModels();
    await collect(client, ask(400, 4096));
    await collect(client, ask(20_000, 4096));
    await collect(client, ask(30_000, 4096));
    const [fits, lowered, capped, room] = server.bodies.map(body => body.max_tokens as number | undefined);
    expect(fits).toBe(4096);
    expect(lowered).toBeGreaterThanOrEqual(256);
    expect(lowered).toBeLessThan(CONTEXT - 5000);
    expect(capped).toBe(4096);
    expect(room).toBe(CONTEXT - 7500);
    expect(server.bodies).toHaveLength(4);
  });

  it('asks again with max_tokens cut by the overshoot when the server counts the prompt longer than the estimate', async () => {
    const server = vllm(2);
    const client = chat(server.fetch, 'vllm');
    await client.listModels();
    const events = await collect(client, ask(14_000, 2048));
    expect(server.bodies.map(body => body.max_tokens)).toEqual([2048, CONTEXT - 7000]);
    expect(events.at(-1)).toMatchObject({ stopReason: 'stop' });
  });

  it('asks again with the room the refusal reports, even on a server that lists no context', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model' }] });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.max_tokens === 2048)
        return Response.json(
          {
            error: {
              message:
                "'max_tokens' or 'max_completion_tokens' is too large: 2048. This model's maximum context length is 8192 tokens and your request has 7000 input tokens (2048 > 8192 - 7000).",
            },
          },
          { status: 400 }
        );
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const client = chat(fetch, 'vllm');
    await client.listModels();
    const events = await collect(client, ask(400, 2048));
    expect(bodies.map(body => body.max_tokens)).toEqual([2048, 1192]);
    expect(events.at(-1)).toMatchObject({ stopReason: 'stop' });
  });

  it('does not ask again for a refusal that is not about the context, or when it sent no max_tokens', async () => {
    const refusing = (status: number, message: string) => {
      const bodies: Record<string, unknown>[] = [];
      const fetch: FetchLike = async (url, init) => {
        if (String(url).endsWith('/v1/models'))
          return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ error: { message } }, { status });
      };
      return { client: chat(fetch, 'vllm'), bodies };
    };
    for (const [status, message, maxTokens] of [
      [400, 'temperature must be at most 2', 2048],
      [400, 'max_tokens must be at least 1, got 0.', 2048],
      [500, 'max_tokens scheduler crashed', 2048],
      [400, "This model's maximum context length is 8192 tokens.", undefined],
      [400, "This model's maximum context length is 8192 tokens and your request has 7000 input tokens.", undefined],
    ] as const) {
      const { client, bodies } = refusing(status, message);
      await client.listModels();
      await expect(collect(client, ask(400, maxTokens))).rejects.toThrow();
      expect(bodies).toHaveLength(1);
    }
  });

  it('keeps the cap and gives up when the refusal names no count that leaves room under it', async () => {
    for (const message of [
      "This model's maximum context length is 8192 tokens.",
      "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens in the messages.",
      "This model's maximum context length is 8192 tokens and your request has 100 input tokens.",
      `This model's maximum context length is 8192 tokens and your request has ${'9'.repeat(400)} input tokens.`,
    ]) {
      const bodies: Record<string, unknown>[] = [];
      const fetch: FetchLike = async (url, init) => {
        if (String(url).endsWith('/v1/models'))
          return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ error: { message } }, { status: 400 });
      };
      const client = chat(fetch, 'vllm');
      await client.listModels();
      await expect(collect(client, ask(400, 2048))).rejects.toThrow();
      expect(bodies.map(body => body.max_tokens)).toEqual([2048]);
    }
  });

  it('asks once more with the room left, then gives up when that is refused too', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(
        {
          error: { message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens." },
        },
        { status: 400 }
      );
    };
    const client = chat(fetch, 'vllm');
    await client.listModels();
    await expect(collect(client, ask(400, 2048))).rejects.toThrow();
    expect(bodies.map(body => body.max_tokens)).toEqual([2048, 2048 - (9000 - CONTEXT)]);
  });

  it('counts the tool definitions in the prompt when the refusal reports them apart from the messages', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length > 1) return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
      return Response.json(
        {
          error: {
            message:
              "This model's maximum context length is 8192 tokens. However, your messages resulted in 7000 tokens (6000 in the messages, 1000 in the functions). Please reduce the length of the messages or functions.",
          },
        },
        { status: 400 }
      );
    };
    const client = chat(fetch, 'vllm');
    await client.listModels();
    await collect(client, ask(400, 2048));
    expect(bodies.map(body => body.max_tokens)).toEqual([2048, CONTEXT - 7000]);
  });

  it('adds the tool definitions to the messages when an OpenAI refusal reports them apart', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length > 1) return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
      return Response.json(
        {
          error: {
            message:
              "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (6000 in the messages, 1000 in the functions, 2000 in the completion). Please reduce the length of the messages, functions, or completion.",
          },
        },
        { status: 400 }
      );
    };
    const client = chat(fetch, 'vllm');
    await client.listModels();
    await collect(client, ask(400, 2048));
    expect(bodies.map(body => body.max_tokens)).toEqual([2048, CONTEXT - 7000]);
  });

  it('does not ask again when the refusal reports a functions count that is not a safe integer', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(
        {
          error: {
            message: `This model's maximum context length is 8192 tokens. However, you requested 9000 tokens (6000 in the messages, ${'9'.repeat(400)} in the functions, 2000 in the completion).`,
          },
        },
        { status: 400 }
      );
    };
    const client = chat(fetch, 'vllm');
    await client.listModels();
    await expect(collect(client, ask(400, 4096))).rejects.toThrow();
    expect(bodies.map(body => body.max_tokens)).toEqual([4096]);
  });

  it('asks again with the room left and without the tools the server refused', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools) return new Response('{"error":{"message":"tools param requires --jinja flag"}}', { status: 500 });
      if (body.max_tokens === 2048)
        return Response.json(
          {
            error: {
              message:
                "This model's maximum context length is 8192 tokens. However, you requested 8500 tokens (6452 in the messages, 2048 in the completion).",
            },
          },
          { status: 400 }
        );
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const client = chat(fetch, 'llama-server');
    await client.listModels();
    const tools = [{ toolSchema: { name: 'read_file', parameters: { type: 'object' } } }];
    await collect(client, { ...ask(400, 2048), tools });
    expect(bodies.map(body => ['tools' in body, body.max_tokens])).toEqual([
      [true, 2048],
      [false, 2048],
      [false, 1740],
    ]);
  });

  it('tells a turn its message is too long for the tools when only the reply room of a large override is missing', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: 32_768 }] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([delta({ content: 'ok' }, 'stop'), '[DONE]']);
    };
    const client = chat(fetch, 'vllm');
    await client.listModels();
    const notices: string[] = [];
    await client.stream(
      { ...ask(400, 6000), sessionId: 's1', toolPromptTokens: 28_000 },
      () => undefined,
      undefined,
      undefined,
      notice => notices.push(notice)
    );
    expect(notices).toEqual([expect.stringMatching(/too long for qwen3-8b's 32768-token context/)]);
  });

  it('sends the limit as given when the server states no context', async () => {
    const server = vllm(4, 0);
    const client = chat(server.fetch, 'vllm');
    await client.listModels();
    await collect(client, ask(30_000, 4096));
    expect(server.bodies[0]).toMatchObject({ max_tokens: 4096 });
  });
});

describe('toOpenAIMessages', () => {
  it('turns tool use and tool results into OpenAI tool calls and tool messages', () => {
    expect(
      toOpenAIMessages([
        { role: 'user', content: 'read a' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'A' }] }],
        },
      ])
    ).toEqual([
      { role: 'user', content: 'read a' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'A' },
    ]);
  });

  it('sends images as data URLs', () => {
    const [message] = toOpenAIMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        ],
      },
    ]);
    expect(message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      ],
    });
  });
});
