import { describe, expect, it, vi } from 'vitest';
import { LOCAL_MODEL_PREFIX, OllamaLocal } from './OllamaLocal';

describe('OllamaLocal', () => {
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
    vi.unstubAllGlobals();
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
    vi.unstubAllGlobals();
  });
});
