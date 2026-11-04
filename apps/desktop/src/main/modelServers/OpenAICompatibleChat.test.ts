import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike, OpenAICompatibleProduct } from '@bike4mind/local-models';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import type { ModelLoadSettings } from '@shared/modelSettings';
import { ServerCredentialsError, ServerForbiddenError } from './errors';
import type { LearnedThinker } from './ModelServerStore';
import { OpenAICompatibleChat, toOpenAIMessages } from './OpenAICompatibleChat';

const BASE = 'http://127.0.0.1:18080';
const MODEL = 'local:srv-abc123:qwen2.5-0.5b';

function sse(frames: readonly (object | string)[]): Response {
  const text = frames.map(frame => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function chat(fetch: FetchLike, product: OpenAICompatibleProduct | null = 'llama-server', toolsChanged?: () => void) {
  return new OpenAICompatibleChat({
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

  it('keeps a limit that fits, lowers one that does not, and sends none without room', async () => {
    const server = vllm(4);
    const client = chat(server.fetch, 'vllm');
    await client.listModels();
    await collect(client, ask(400, 4096));
    await collect(client, ask(20_000, 4096));
    await collect(client, ask(30_000, 4096));
    const [fits, lowered, none] = server.bodies.map(body => body.max_tokens as number | undefined);
    expect(fits).toBe(4096);
    expect(lowered).toBeGreaterThanOrEqual(256);
    expect(lowered).toBeLessThan(CONTEXT - 5000);
    expect(none).toBeUndefined();
    expect(server.bodies).toHaveLength(3);
  });

  it('asks again without max_tokens when the server counts the prompt longer than the estimate', async () => {
    const server = vllm(2);
    const client = chat(server.fetch, 'vllm');
    await client.listModels();
    const events = await collect(client, ask(14_000, 2048));
    expect(server.bodies.map(body => body.max_tokens)).toEqual([2048, undefined]);
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
    ] as const) {
      const { client, bodies } = refusing(status, message);
      await client.listModels();
      await expect(collect(client, ask(400, maxTokens))).rejects.toThrow();
      expect(bodies).toHaveLength(1);
    }
  });

  it('asks once more without max_tokens, then gives up when that is refused too', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(
        { error: { message: "This model's maximum context length is 8192 tokens." } },
        { status: 400 }
      );
    };
    const client = chat(fetch, 'vllm');
    await client.listModels();
    await expect(collect(client, ask(400, 2048))).rejects.toThrow();
    expect(bodies.map(body => body.max_tokens)).toEqual([2048, undefined]);
  });

  it('asks again without max_tokens and without the tools the server refused', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/models'))
        return Response.json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model', max_model_len: CONTEXT }] });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools) return new Response('{"error":{"message":"tools param requires --jinja flag"}}', { status: 500 });
      if (body.max_tokens)
        return Response.json(
          { error: { message: "This model's maximum context length is 8192 tokens." } },
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
      [false, undefined],
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
