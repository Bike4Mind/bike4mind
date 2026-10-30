/**
 * Pins that the Anthropic backend reports slot waits and transport retries to the per-turn
 * telemetry sink (`_internal.turnTelemetry`), on both the streaming and non-streaming paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

const messageStart = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };

const streamedTurn = [
  messageStart,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];

const message = {
  content: [{ type: 'text', text: 'Done.' }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: 'end_turn',
};

/** Fails the first create() with a transient network error, then resolves with `reply`. */
function buildBackend(reply: unknown) {
  const backend = new AnthropicBackend('test-key');
  const create = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue(reply);
  (backend as unknown as { _api: unknown })._api = { messages: { create } };
  return { backend, create };
}

function streamOf(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) yield event;
    },
    controller: { abort: () => {} },
  };
}

describe('AnthropicBackend - turn telemetry sink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['streaming', true],
    ['non-streaming', false],
  ])('reports the slot wait and a transport retry on the %s path', async (_label, stream) => {
    const { backend, create } = buildBackend(stream ? streamOf(streamedTurn) : message);
    const turnTelemetry = { onSemaphoreWait: vi.fn(), onRetry: vi.fn() };

    const turn = backend.complete(
      ChatModels.CLAUDE_4_8_OPUS,
      [{ role: 'user', content: 'hi' }],
      { stream, _internal: { turnTelemetry } },
      async () => {}
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await turn;

    expect(create).toHaveBeenCalledTimes(2);
    expect(turnTelemetry.onSemaphoreWait).toHaveBeenCalledWith(expect.any(Number));
    expect(turnTelemetry.onRetry).toHaveBeenCalledTimes(1);
    expect(turnTelemetry.onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ message: 'fetch failed' }),
        delayMs: expect.any(Number),
        model: ChatModels.CLAUDE_4_8_OPUS,
      })
    );
  });
});
