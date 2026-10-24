import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_MODEL_PREFIX, OllamaLocal } from './OllamaLocal';

describe('OllamaLocal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
        id: `${LOCAL_MODEL_PREFIX}qwen3:8b`,
        supportsTools: true,
        thinkingToggle: true,
        contextWindow: 32768,
      }),
    ]);
    expect(vi.mocked(fetch).mock.calls.every(([input]) => String(input).startsWith('http://127.0.0.1:11434/'))).toBe(
      true
    );
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
      { model: `${LOCAL_MODEL_PREFIX}llama`, messages: [{ role: 'user', content: 'hi' }] },
      event => events.push(event)
    );
    expect(events).toEqual([
      { type: 'content', text: 'hello' },
      { type: 'content', stopReason: 'stop' },
    ]);
  });

  const streamWith = async (body: string, request: Partial<Parameters<OllamaLocal['stream']>[0]> = {}) => {
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) =>
      String(input).endsWith('/api/show')
        ? Response.json({ capabilities: ['completion'] })
        : new Response(body, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];
    await new OllamaLocal().stream(
      { model: `${LOCAL_MODEL_PREFIX}llama`, messages: [{ role: 'user', content: 'hi' }], ...request },
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
    expect(sent.options).toEqual({ num_predict: 256 });
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
    expect((await new OllamaLocal().models()).map(model => model.id)).toEqual([`${LOCAL_MODEL_PREFIX}chat`]);
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
      new OllamaLocal().stream(
        { model: `${LOCAL_MODEL_PREFIX}llama`, messages: [] },
        () => undefined,
        controller.signal
      )
    ).rejects.toThrow('malformed stream');
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(controller.signal);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('fails the turn on an error frame', async () => {
    await expect(streamWith(`${JSON.stringify({ error: 'model requires more memory' })}\n`)).rejects.toThrow(
      'model requires more memory'
    );
  });

  it('fails on an HTTP error or an invalid model id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 }))
    );
    const local = new OllamaLocal();
    await expect(local.stream({ model: `${LOCAL_MODEL_PREFIX}llama`, messages: [] }, () => undefined)).rejects.toThrow(
      'HTTP 500'
    );
    await expect(local.stream({ model: 'gpt-4', messages: [] }, () => undefined)).rejects.toThrow('Invalid local');
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
        local.stream(
          { model: `${LOCAL_MODEL_PREFIX}alias`, messages: [{ role: 'user', content: 'private' }] },
          () => {}
        )
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
    expect((await new OllamaLocal().models()).map(model => model.id)).toEqual([`${LOCAL_MODEL_PREFIX}local`]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
