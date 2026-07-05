/**
 * Pins the Claude Fable 5 safety-classifier refusal contract in the Anthropic backend.
 *
 * When Fable 5's cyber/bio classifiers decline, the API returns a successful HTTP 200 stream
 * ending in message_delta with stop_reason: 'refusal' and empty content. complete() converts
 * that into a thrown error the fallback loop recognizes (shouldTriggerFallback ->
 * getLlmWithFallback), rather than surfacing a silently-empty completion. Scoped to
 * REFUSAL_FALLBACK_MODELS, so a refusal from any other model (a genuine decline) still
 * resolves normally and surfaces to the caller unchanged.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicBackend } from '../anthropicBackend';
import { ChatModels } from '@bike4mind/common';

function asyncIterable(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    controller: { abort: () => {} },
  };
}

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const responseQueue: unknown[][] = [];
  type AnthropicApiMock = { messages: { create: (...args: unknown[]) => unknown } };
  (backend as unknown as { _api: AnthropicApiMock })._api = {
    messages: { create: async () => asyncIterable(responseQueue.shift() ?? []) },
  };
  return {
    backend,
    enqueue: (...turns: unknown[][]) => turns.forEach(t => responseQueue.push(t)),
  };
}

// A pre-output safety-classifier refusal: no content blocks, terminal message_delta carrying
// stop_reason: 'refusal'.
function refusalTurn(): unknown[] {
  return [
    { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { input_tokens: 12, output_tokens: 0 } },
    { type: 'message_stop' },
  ];
}

describe('AnthropicBackend — safety-classifier refusal fallback', () => {
  it('rejects with a recognized error when Fable 5 refuses (routes to the fallback loop)', async () => {
    const { backend, enqueue } = buildBackend();
    enqueue(refusalTurn());

    await expect(
      backend.complete(
        ChatModels.CLAUDE_FABLE_5,
        [{ role: 'user', content: 'benign adjacent request' }],
        { stream: true },
        async () => {}
      )
    ).rejects.toThrow(/safety classifier refusal/i);
  });

  it('does NOT convert a refusal from a non-fallback model into an error (genuine decline surfaces)', async () => {
    const { backend, enqueue } = buildBackend();
    enqueue(refusalTurn());

    // Opus 4.8 is not in REFUSAL_FALLBACK_MODELS - a refusal here is a genuine decline and must
    // resolve normally (empty completion), not be rerouted to another model.
    await expect(
      backend.complete(
        ChatModels.CLAUDE_4_8_OPUS,
        [{ role: 'user', content: 'a request the model declines' }],
        { stream: true },
        async () => {}
      )
    ).resolves.not.toThrow();
  });
});
