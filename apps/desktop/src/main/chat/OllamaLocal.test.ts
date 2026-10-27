import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletionMessage } from './completions';
import type { CompletionStreamEvent } from './streamEvents';
import { OllamaLocal } from './OllamaLocal';

describe('OllamaLocal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['gpt-4', 'local:lmstudio:x', 'local:', 'local:ollama', 'local:ollama:', 'local::x'])(
    'rejects unsupported or malformed model id %s before network I/O',
    async model => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(new OllamaLocal().stream({ model, messages: [] }, () => undefined)).rejects.toThrow(
        'Invalid local model id.'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('discovers localhost models with namespaced ids and reported capabilities', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        return new Response(
          JSON.stringify(
            url.endsWith('/api/tags')
              ? { models: [{ name: 'qwen3:8b' }] }
              : { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'qwen.context_length': 32768 } }
          ),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );
    const models = await new OllamaLocal().models();
    expect(models).toEqual([
      expect.objectContaining({
        id: 'local:ollama:qwen3:8b',
        supportsTools: true,
        thinkingToggle: true,
        contextWindow: 16384,
      }),
    ]);
    expect(vi.mocked(fetch).mock.calls.every(([input]) => String(input).startsWith('http://127.0.0.1:11434/'))).toBe(
      true
    );
  });

  it.each([
    { info: {}, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': 32768 }, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': 2048 }, parameters: undefined, expected: 2048 },
    { info: { 'llama.context_length': -1 }, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': '32768' }, parameters: undefined, expected: 16384 },
    { info: { 'llama.context_length': 32768 }, parameters: 'num_ctx 8192', expected: 16384 },
    { info: { 'llama.context_length': 131072 }, parameters: 'num_ctx 32768', expected: 32768 },
    { info: { 'llama.context_length': 2048 }, parameters: 'num_ctx 8192', expected: 2048 },
    { info: {}, parameters: 'temperature 0.7\nnum_ctx 65536\n', expected: 65536 },
    ...['0', '-1', 'Infinity', 'NaN', '1.5', 'invalid'].map(value => ({
      info: {},
      parameters: `num_ctx ${value}`,
      expected: 16384,
    })),
  ])('uses the same effective context for discovery and inference: %j', async ({ info, parameters, expected }) => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: 'llama' }] });
      if (String(input).endsWith('/api/show'))
        return Response.json({ capabilities: ['completion'], model_info: info, parameters });
      return new Response(`${JSON.stringify({ done: true })}\n`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const local = new OllamaLocal();
    expect((await local.models())[0].contextWindow).toBe(expected);
    await local.stream({ model: 'local:ollama:llama', messages: [] }, () => undefined);
    const sent = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as { options: { num_ctx: number } };
    expect(sent.options.num_ctx).toBe(expected);
  });

  it('hides the provider when discovery times out or is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      )
    );
    vi.useFakeTimers();
    const pending = new OllamaLocal().models();
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(pending).resolves.toEqual([]);
  });

  it.each([true, false])('omits thinking %s when the fresh inspection reports a plain model', async thinking => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show')
        ? Response.json({ capabilities: ['completion'] })
        : new Response(`${JSON.stringify({ done: true })}\n`)
    );
    vi.stubGlobal('fetch', fetchMock);
    await new OllamaLocal().stream(
      { model: 'local:ollama:llama3.2', messages: [{ role: 'user', content: 'hi' }], thinking },
      () => undefined
    );
    const sent = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('think');
  });

  it('streams a plain offline answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) =>
        String(input).endsWith('/api/show')
          ? Response.json({ capabilities: ['completion'] })
          : new Response(
              `${JSON.stringify({ message: { content: 'hello' }, done: false })}\n${JSON.stringify({ message: {}, done: true, done_reason: 'stop' })}\n`,
              { status: 200 }
            )
      )
    );
    const events: unknown[] = [];
    await new OllamaLocal().stream(
      { model: 'local:ollama:llama', messages: [{ role: 'user', content: 'hi' }] },
      event => events.push(event)
    );
    expect(events).toEqual([
      { type: 'content', text: 'hello' },
      { type: 'content', stopReason: 'stop' },
    ]);
  });

  it('streams chat through the fetch it is given and keeps the short calls on global fetch', async () => {
    const globalFetch = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/tags')
        ? Response.json({ models: [{ name: 'llama' }] })
        : Response.json({ capabilities: ['completion'] })
    );
    vi.stubGlobal('fetch', globalFetch);
    const given = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(`${JSON.stringify({ message: { content: 'hi' }, done: true })}\n`)
    );
    const local = new OllamaLocal(given);
    await local.models();
    await local.stream({ model: 'local:ollama:llama', messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
    expect(given.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:11434/api/chat']);
    expect(globalFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:11434/api/tags',
      'http://127.0.0.1:11434/api/show',
      'http://127.0.0.1:11434/api/show',
    ]);
  });

  const streamWith = async (body: string, request: Partial<Parameters<OllamaLocal['stream']>[0]> = {}) => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show')
        ? Response.json({ capabilities: ['completion', 'thinking'] })
        : new Response(body, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];
    await new OllamaLocal().stream(
      { model: 'local:ollama:llama', messages: [{ role: 'user', content: 'hi' }], ...request },
      event => events.push(event)
    );
    return {
      events,
      sent: JSON.parse(
        String(
          (fetchMock.mock.calls[1] as unknown[][])[1] &&
            ((fetchMock.mock.calls[1] as unknown[][])[1] as RequestInit).body
        )
      ),
    };
  };

  it('sends tool calls, tool results and screenshots in the Ollama chat format', async () => {
    const { sent } = await streamWith(`${JSON.stringify({ done: true })}\n`, {
      thinking: true,
      maxTokens: 256,
      messages: [
        { role: 'user', content: 'look' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'browser_screenshot', input: { full: true } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'image', source: { type: 'base64', data: 'AAAA' } },
          ],
        },
      ],
    });
    expect(sent.model).toBe('llama');
    expect(sent.think).toBe(true);
    expect(sent.options).toEqual({ num_ctx: 16384, num_predict: 256 });
    expect(sent.truncate).toBe(false);
    expect(sent.shift).toBe(false);
    expect(sent.messages).toEqual([
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'browser_screenshot', arguments: { full: true } } }],
      },
      { role: 'tool', content: 'ok', tool_name: 'browser_screenshot' },
      { role: 'user', content: '', images: ['AAAA'] },
    ]);
  });

  it('rejects malformed and truncated streams instead of persisting partial success', async () => {
    await expect(streamWith('not-json\n')).rejects.toThrow('malformed stream');
    await expect(streamWith(`${JSON.stringify({ message: { content: 'partial' } })}\n`)).rejects.toThrow(
      'before the reply finished'
    );
  });

  it('sends an explicit disabled thinking preference', async () => {
    const { sent } = await streamWith(`${JSON.stringify({ done: true })}\n`, { thinking: false });
    expect(sent.think).toBe(false);
  });

  it.each([
    ['length', 'max_tokens'],
    ['stop', 'stop'],
    [undefined, 'end_turn'],
    ['custom', 'custom'],
  ])('normalizes Ollama stop reason %s to %s', async (reason, expected) => {
    const { events } = await streamWith(`${JSON.stringify({ done: true, done_reason: reason })}\n`);
    expect(events).toEqual([{ type: 'content', stopReason: expected }]);
  });

  it('excludes embedding-only models and models whose capabilities could not be inspected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).endsWith('/api/tags'))
          return Response.json({ models: [{ name: 'embed' }, { name: 'broken' }, { name: 'chat' }] });
        const { name } = JSON.parse(String(init?.body)) as { name: string };
        if (name === 'broken') return new Response('', { status: 500 });
        return Response.json({ capabilities: name === 'embed' ? ['embedding'] : ['completion'] });
      })
    );
    expect((await new OllamaLocal().models()).map(model => model.id)).toEqual(['local:ollama:chat']);
  });

  it('translates thinking and tool-call frames', async () => {
    const { events } = await streamWith(
      `${JSON.stringify({
        message: {
          thinking: 'reason',
          tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: { path: 'README.md' } } }],
        },
        done: true,
      })}\n`
    );
    expect(events).toEqual([
      { type: 'content', text: '<think>reason</think>' },
      { type: 'tool_use', tools: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' }] },
      { type: 'content', stopReason: 'end_turn' },
    ]);
  });

  it('passes cancellation through and releases the stream after a frame error', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('bad-json\n'));
      },
      cancel,
    });
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show') ? Response.json({ capabilities: ['completion'] }) : new Response(body)
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(
      new OllamaLocal().stream({ model: 'local:ollama:llama', messages: [] }, () => undefined, controller.signal)
    ).rejects.toThrow('malformed stream');
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(controller.signal);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([
    { prompt_eval_count: 3000, eval_count: 12, usage: { inputTokens: 3000, outputTokens: 12 } },
    { prompt_eval_count: 0, eval_count: 0, usage: { inputTokens: 0, outputTokens: 0 } },
    { prompt_eval_count: 3000, usage: { inputTokens: 3000 } },
    { eval_count: 12, usage: { outputTokens: 12 } },
    { prompt_eval_count: -1, eval_count: '12', usage: undefined },
    { prompt_eval_count: 1.5, eval_count: null, usage: undefined },
  ])('preserves only reported valid token counts: %j', async ({ usage, ...counts }) => {
    const { events } = await streamWith(`${JSON.stringify({ done: true, ...counts })}\n`);
    expect(events).toEqual([{ type: 'content', stopReason: 'end_turn', ...(usage ? { usage } : {}) }]);
  });

  it('ignores token counts on partial frames until the final measurement arrives', async () => {
    const { events } = await streamWith(
      `${JSON.stringify({ message: { content: 'answer' }, prompt_eval_count: 20 })}\n${JSON.stringify({ done: true, prompt_eval_count: 30, eval_count: 4 })}\n`
    );
    expect(events).toEqual([
      { type: 'content', text: 'answer' },
      { type: 'content', stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 4 } },
    ]);
  });

  it('fails the turn on an error frame', async () => {
    await expect(streamWith(`${JSON.stringify({ error: 'model requires more memory' })}\n`)).rejects.toThrow(
      'model requires more memory'
    );
  });

  describe('context overflow', () => {
    const overflow = (tokens: number) =>
      Response.json(
        { error: `request (${tokens} tokens) exceeds the available context size (2048 tokens), try increasing it` },
        { status: 400 }
      );
    const chatWith = (...replies: (() => Response)[]) => {
      const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
        String(input).endsWith('/api/show')
          ? Response.json({ capabilities: ['completion'], model_info: { 'llama.context_length': 2048 } })
          : (replies.shift() ?? (() => new Response(`${JSON.stringify({ done: true })}\n`)))()
      );
      vi.stubGlobal('fetch', fetchMock);
      const sent = () =>
        fetchMock.mock.calls
          .filter(([input]) => String(input).endsWith('/api/chat'))
          .map(([, init]) => (JSON.parse(String(init?.body)) as { messages: { content: string }[] }).messages);
      return { sent };
    };
    const conversation = (oldChars: number) => [
      { role: 'system' as const, content: 'instructions' },
      { role: 'user' as const, content: 'x'.repeat(oldChars) },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'user' as const, content: 'latest' },
    ];

    it('sends a conversation the estimate says is too long whole while Ollama accepts it', async () => {
      const { sent } = chatWith();
      const onTrimmed = vi.fn();
      const messages: CompletionMessage[] = [{ role: 'system', content: 'instructions' }];
      for (let turn = 0; turn < 30; turn++)
        messages.push(
          { role: 'user', content: `u${turn}${'x'.repeat(300)}` },
          { role: 'assistant', content: `a${turn}${'x'.repeat(300)}` }
        );
      await new OllamaLocal().stream({ model: 'local:ollama:llama', messages }, () => undefined, undefined, onTrimmed);
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toHaveLength(61);
      expect(onTrimmed).not.toHaveBeenCalled();
    });

    it('drops the oldest turns and retries once when Ollama measures the prompt as too long', async () => {
      const { sent } = chatWith(
        () => overflow(3000),
        () => new Response(`${JSON.stringify({ done: true, prompt_eval_count: 1500, eval_count: 5 })}\n`)
      );
      const onTrimmed = vi.fn();
      const events: CompletionStreamEvent[] = [];
      await new OllamaLocal().stream(
        { model: 'local:ollama:llama', messages: conversation(4_000) },
        event => events.push(event),
        undefined,
        onTrimmed
      );
      expect(sent().map(messages => messages.map(message => message.content.slice(0, 12)))).toEqual([
        ['instructions', 'xxxxxxxxxxxx', 'old answer', 'latest'],
        ['instructions', 'latest'],
      ]);
      expect(onTrimmed).toHaveBeenCalledWith(2);
      // The whole conversation's size, which is what the next turn's auto-compaction reads.
      expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 3000, outputTokens: 5 } });
    });

    it('records the whole size as soon as the trimmed retry is accepted, before any reply arrives', async () => {
      chatWith(
        () => overflow(3000),
        () => new Response(`${JSON.stringify({ message: { content: 'Partial' } })}\n`)
      );
      const events: CompletionStreamEvent[] = [];
      await expect(
        new OllamaLocal().stream({ model: 'local:ollama:llama', messages: conversation(4_000) }, event =>
          events.push(event)
        )
      ).rejects.toThrow('before the reply finished');
      expect(events[0]).toEqual({ type: 'content', usage: { inputTokens: 3000 } });
    });

    it('fails with the measured size when the latest turn alone does not fit', async () => {
      const { sent } = chatWith(() => overflow(6000));
      const onTrimmed = vi.fn();
      await expect(
        new OllamaLocal().stream(
          {
            model: 'local:ollama:llama',
            messages: [
              { role: 'system', content: 'instructions' },
              { role: 'user', content: 'x'.repeat(20_000) },
            ],
          },
          () => undefined,
          undefined,
          onTrimmed
        )
      ).rejects.toThrow('take 6000 tokens, more than the 2048');
      expect(sent()).toHaveLength(1);
      expect(onTrimmed).not.toHaveBeenCalled();
    });

    it('fails with the measured size when the trimmed prompt still does not fit', async () => {
      const { sent } = chatWith(
        () => overflow(3000),
        () => overflow(2100)
      );
      await expect(
        new OllamaLocal().stream({ model: 'local:ollama:llama', messages: conversation(4_000) }, () => undefined)
      ).rejects.toThrow('take 2100 tokens, more than the 2048');
      expect(sent()).toHaveLength(2);
    });

    const turns = (count: number, chars: number): CompletionMessage[] => [
      { role: 'system', content: 'instructions' },
      ...Array.from({ length: count }, (_, turn): CompletionMessage[] => [
        { role: 'user', content: `u${turn}${'x'.repeat(chars)}` },
        { role: 'assistant', content: `a${turn}${'y'.repeat(chars / 5)}` },
      ]).flat(),
      { role: 'user', content: 'latest' },
    ];

    it('rescales from each refusal and retries until the prompt fits', async () => {
      const { sent } = chatWith(
        () => overflow(1900),
        () => overflow(2000)
      );
      const onTrimmed = vi.fn();
      await new OllamaLocal().stream(
        { model: 'local:ollama:llama', messages: turns(3, 2000) },
        () => undefined,
        undefined,
        onTrimmed
      );
      expect(sent().map(messages => messages.length)).toEqual([8, 6, 4]);
      expect(sent()[2].map(message => message.content.slice(0, 2))).toEqual(['in', 'u2', 'a2', 'la']);
      // Two prompts and their two replies, reported once the reply is under way.
      expect(onTrimmed).toHaveBeenCalledTimes(1);
      expect(onTrimmed).toHaveBeenCalledWith(4);
    });

    it('stops after a few retries even while older turns remain', async () => {
      const { sent } = chatWith(...Array.from({ length: 6 }, () => () => overflow(2049)));
      const onTrimmed = vi.fn();
      await expect(
        new OllamaLocal().stream(
          { model: 'local:ollama:llama', messages: turns(20, 320) },
          () => undefined,
          undefined,
          onTrimmed
        )
      ).rejects.toThrow('after leaving out its');
      expect(sent()).toHaveLength(4);
      expect(onTrimmed).not.toHaveBeenCalled();
    });

    it('sends screenshots without the marker that keeps them in their turn', async () => {
      const { sent } = chatWith();
      await new OllamaLocal().stream(
        {
          model: 'local:ollama:llama',
          messages: [
            { role: 'user', content: 'look' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Image from the shot call above.' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              ],
              continuesTurn: true,
            },
          ],
        },
        () => undefined
      );
      expect(JSON.stringify(sent())).not.toContain('continuesTurn');
      expect(sent()[0].at(-1)).toEqual({ role: 'user', content: 'Image from the shot call above.', images: ['AAAA'] });
    });

    it("reports Ollama's error text for other refusals", async () => {
      chatWith(() => Response.json({ error: 'model is busy' }, { status: 400 }));
      await expect(
        new OllamaLocal().stream({ model: 'local:ollama:llama', messages: conversation(10) }, () => undefined)
      ).rejects.toThrow('Ollama returned HTTP 400: model is busy');
    });
  });

  it('fails on an HTTP error or an invalid model id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 }))
    );
    const local = new OllamaLocal();
    await expect(local.stream({ model: 'local:ollama:llama', messages: [] }, () => undefined)).rejects.toThrow(
      'HTTP 500'
    );
    await expect(local.stream({ model: 'gpt-4', messages: [] }, () => undefined)).rejects.toThrow('Invalid local');
  });

  it('says plainly when the model was removed from Ollama', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: "model 'hf.co/a/b:Q4_K_M' not found" }, { status: 404 }))
    );
    await expect(
      new OllamaLocal().stream({ model: 'local:ollama:hf.co/a/b:Q4_K_M', messages: [] }, () => undefined)
    ).rejects.toThrow('This model was removed from Ollama. Pick another model.');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('404 page not found', { status: 404 }))
    );
    await expect(
      new OllamaLocal().stream({ model: 'local:ollama:llama', messages: [] }, () => undefined)
    ).rejects.toThrow('Ollama returned HTTP 404.');
  });
});

describe('Ollama local-only inference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it.each([{ remote_host: 'https://ollama.com' }, { remote_model: 'private-cloud-alias' }])(
    'excludes remote metadata %j and refuses to send private prompts',
    async remote => {
      const fetchMock = vi.fn(async (input: unknown) =>
        String(input).endsWith('/api/tags')
          ? Response.json({ models: [{ name: 'alias' }] })
          : Response.json({ capabilities: ['completion'], ...remote })
      );
      vi.stubGlobal('fetch', fetchMock);
      const local = new OllamaLocal();
      expect(await local.models()).toEqual([]);
      await expect(
        local.stream({ model: 'local:ollama:alias', messages: [{ role: 'user', content: 'private' }] }, () => {})
      ).rejects.toThrow('Cloud-backed');
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/chat'))).toBe(false);
    }
  );

  it('excludes remote tags before inspection and accepts empty remote fields for installed models', async () => {
    const fetchMock = vi.fn(async (input: unknown) =>
      String(input).endsWith('/api/tags')
        ? Response.json({
            models: [
              { name: 'remote', remote_host: 'https://ollama.com' },
              { name: 'local', remote_host: '', remote_model: '' },
            ],
          })
        : Response.json({ capabilities: ['completion'], remote_host: '', remote_model: '' })
    );
    vi.stubGlobal('fetch', fetchMock);
    expect((await new OllamaLocal().models()).map(model => model.id)).toEqual(['local:ollama:local']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
