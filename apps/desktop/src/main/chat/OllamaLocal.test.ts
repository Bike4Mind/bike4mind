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
              : { capabilities: ['tools', 'thinking'], model_info: { 'qwen.context_length': 32768 } }
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
      vi.fn(
        async () =>
          new Response(
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
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
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
          (fetchMock.mock.calls[0] as unknown[][])[1] &&
            ((fetchMock.mock.calls[0] as unknown[][])[1] as RequestInit).body
        )
      ),
    };
  };

  it('sends tool calls, tool results and screenshots in the Ollama chat format', async () => {
    const { sent } = await streamWith('', {
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

  it('skips a malformed line and keeps streaming', async () => {
    const { events } = await streamWith(
      `not-json\n${JSON.stringify({ message: { content: 'ok' }, done: true, done_reason: 'stop' })}\n`
    );
    expect(events).toEqual([
      { type: 'content', text: 'ok' },
      { type: 'content', stopReason: 'stop' },
    ]);
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
