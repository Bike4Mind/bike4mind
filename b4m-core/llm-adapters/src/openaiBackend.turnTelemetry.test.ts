/**
 * Pins that the OpenAI backend reports transport retries to the per-turn telemetry sink
 * (`_internal.turnTelemetry`), on the streaming and non-streaming chat paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { Stream } from 'openai/streaming';
import { OpenAIBackend } from './openaiBackend';

const streamedChunks = [
  {
    choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
];

const completion = {
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

/** Fails the first create() with a transient network error, then resolves with `reply()`. */
function buildBackend(reply: () => unknown) {
  const backend = new OpenAIBackend('test-key');
  const create = vi
    .fn()
    .mockRejectedValueOnce(new Error('fetch failed'))
    .mockImplementation(async () => reply());
  (backend as unknown as { _api: unknown })._api = { chat: { completions: { create } } };
  return { backend, create };
}

const chunkStream = () =>
  new Stream(
    (() =>
      (async function* () {
        for (const chunk of streamedChunks) yield chunk;
      })()) as never,
    new AbortController()
  );

describe('OpenAIBackend - turn telemetry sink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['streaming', true, chunkStream],
    ['non-streaming', false, () => completion],
  ])('reports a transport retry on the %s path', async (_label, stream, reply) => {
    const { backend, create } = buildBackend(reply);
    const turnTelemetry = { onSemaphoreWait: vi.fn(), onRetry: vi.fn() };

    const turn = backend.complete(
      ChatModels.GPT5_5,
      [{ role: 'user', content: 'hi' }],
      { stream, _internal: { turnTelemetry } },
      async () => {}
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await turn;

    expect(create).toHaveBeenCalledTimes(2);
    expect(turnTelemetry.onRetry).toHaveBeenCalledTimes(1);
    expect(turnTelemetry.onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'fetch failed' }),
        delayMs: expect.any(Number),
        model: ChatModels.GPT5_5,
      })
    );
  });
});
