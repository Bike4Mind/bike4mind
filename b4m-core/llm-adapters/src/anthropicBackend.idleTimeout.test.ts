/**
 * Pins which stream idle timeout the Anthropic backend picks. An adaptive model reasons on every
 * turn even when the caller never enabled thinking, and that reasoning can stream nothing for
 * long stretches, so it must get the thinking budget (180s) rather than the default (90s).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

const messageStart = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };

/** Yields message_start, then stalls until the backend aborts the stream, like a hung connection. */
function stalledStream() {
  let rejectStall: (error: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    rejectStall = reject;
  });
  const abortedState = { aborted: false };
  return {
    abortedState,
    stream: {
      [Symbol.asyncIterator]: async function* () {
        yield messageStart;
        await stalled;
      },
      controller: {
        abort: () => {
          abortedState.aborted = true;
          const error = new Error('Request was aborted.');
          error.name = 'AbortError';
          rejectStall(error);
        },
      },
    },
  };
}

function buildBackend(stream: unknown) {
  const backend = new AnthropicBackend('test-key');
  type AnthropicApiMock = { messages: { create: (...args: unknown[]) => unknown } };
  (backend as unknown as { _api: AnthropicApiMock })._api = {
    messages: { create: async () => stream },
  };
  return backend;
}

/** Starts a streaming turn that stalls after message_start; the outcome is captured, not thrown. */
function startStalledTurn(model: string) {
  const { stream, abortedState } = stalledStream();
  const backend = buildBackend(stream);
  const outcome: { settled: boolean; error?: Error } = { settled: false };
  const turn = backend
    .complete(
      model,
      [{ role: 'user', content: 'hi' }],
      { stream: true, _internal: { enableIdleTimeout: true } },
      async () => {}
    )
    .catch((error: unknown) => {
      outcome.error = error instanceof Error ? error : new Error(String(error));
    })
    .finally(() => {
      outcome.settled = true;
    });
  return { turn, outcome, abortedState };
}

describe('AnthropicBackend - stream idle timeout selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives an adaptive model the 180s thinking budget even when thinking is not enabled', async () => {
    const { turn, outcome, abortedState } = startStalledTurn(ChatModels.CLAUDE_5_OPUS);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(abortedState.aborted).toBe(false);
    expect(outcome.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(61_000);
    await turn;

    expect(abortedState.aborted).toBe(true);
    expect(outcome.error?.message).toContain('180 seconds');
  });

  it('keeps the 90s default idle timeout for a non-adaptive model', async () => {
    const { turn, outcome, abortedState } = startStalledTurn(ChatModels.CLAUDE_4_5_SONNET);

    await vi.advanceTimersByTimeAsync(89_000);
    expect(abortedState.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await turn;

    expect(abortedState.aborted).toBe(true);
    expect(outcome.error?.message).toContain('90 seconds');
  });
});
