/**
 * Pins which stream idle timeout the Anthropic backend picks. An adaptive model reasons on every
 * turn even when the caller never enabled thinking, and that reasoning can stream nothing for
 * long stretches, so it must get the thinking budget (180s) rather than the default (90s).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptions } from './backend';
import { LlmTimeoutError } from './llmTimeoutErrors';

const { sendMetric } = vi.hoisted(() => ({ sendMetric: vi.fn(async (_command: { input: unknown }) => ({})) }));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = sendMetric;
  },
  PutMetricDataCommand: class {
    constructor(readonly input: unknown) {}
  },
  StandardUnit: { Count: 'Count' },
}));

// Idle timeouts emit detached metrics; keep their network and logging inside this fixture.
const makeLogger = () => Object.assign(new Logger(), { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
});

const messageStart = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } };

/** Yields message_start, then stalls until the backend aborts the stream, like a hung connection. */
function stalledStream(reportUsage = true) {
  let rejectStall: (error: Error) => void = () => {};
  const stalled = new Promise<never>((_, reject) => {
    rejectStall = reject;
  });
  const abortedState = { aborted: false };
  return {
    abortedState,
    stream: {
      [Symbol.asyncIterator]: async function* () {
        if (reportUsage) yield messageStart;
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
  const backend = new AnthropicBackend('test-key', makeLogger());
  type AnthropicApiMock = { messages: { create: (...args: unknown[]) => unknown } };
  (backend as unknown as { _api: AnthropicApiMock })._api = {
    messages: { create: async () => stream },
  };
  return backend;
}

type TurnInternal = NonNullable<ICompletionOptions['_internal']>;

/** Starts a streaming turn that stalls after message_start; the outcome is captured, not thrown. */
function startStalledTurn(model: string, internal: Omit<TurnInternal, 'enableIdleTimeout'> = {}) {
  const { stream, abortedState } = stalledStream();
  const backend = buildBackend(stream);
  const outcome: { settled: boolean; error?: Error } = { settled: false };
  const turn = backend
    .complete(
      model,
      [{ role: 'user', content: 'hi' }],
      { stream: true, _internal: { ...internal, enableIdleTimeout: true } },
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

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(0);
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

  it('rejects with a typed stream_idle timeout that never says overloaded', async () => {
    const { turn, outcome } = startStalledTurn(ChatModels.CLAUDE_4_5_SONNET);

    await vi.advanceTimersByTimeAsync(91_000);
    await turn;

    expect(outcome.error).toBeInstanceOf(LlmTimeoutError);
    expect(outcome.error).toMatchObject({ kind: 'stream_idle', timeoutMs: 90_000 });
    expect(outcome.error?.message).toContain('stream timeout');
    expect(outcome.error?.message.toLowerCase()).not.toContain('overloaded');
    expect(sendMetric).toHaveBeenCalledOnce();
    // The Stage-only datum is the one an alarm can sum across models.
    const { MetricData } = sendMetric.mock.calls[0][0].input as { MetricData: { Dimensions: unknown }[] };
    const stage = { Name: 'Stage', Value: process.env.SEED_STAGE_NAME || 'local' };
    expect(MetricData.map(datum => datum.Dimensions)).toEqual([
      [{ Name: 'Model', Value: ChatModels.CLAUDE_4_5_SONNET }, stage],
      [stage],
    ]);
  });

  it('carries the completed tool rounds of the call on the timeout, output included', async () => {
    const { turn, outcome } = startStalledTurn(ChatModels.CLAUDE_4_5_SONNET, {
      accumInputTokens: 300,
      accumOutputTokens: 250,
      accumCacheReadTokens: 4000,
      accumCacheWriteTokens: 60,
      accumTurnUsage: [
        { inputTokens: 300, outputTokens: 250, cacheReadInputTokens: 4000, cacheCreationInputTokens: 60 },
      ],
    });

    await vi.advanceTimersByTimeAsync(91_000);
    await turn;

    expect(outcome.error).toMatchObject({
      name: 'LlmTimeoutError',
      usage: {
        inputTokens: 310,
        outputTokens: 250,
        cacheReadInputTokens: 4000,
        cacheCreationInputTokens: 60,
        turnUsage: [
          { inputTokens: 300, outputTokens: 250, cacheReadInputTokens: 4000, cacheCreationInputTokens: 60 },
          { inputTokens: 10, outputTokens: 0 },
        ],
      },
    });
  });

  it('leaves output off the timeout when no earlier round completed', async () => {
    const { turn, outcome } = startStalledTurn(ChatModels.CLAUDE_4_5_SONNET);

    await vi.advanceTimersByTimeAsync(91_000);
    await turn;

    expect((outcome.error as LlmTimeoutError).usage).toEqual({
      inputTokens: 10,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('keeps only completed rounds when the next round times out before message_start', async () => {
    const priorTurns = [{ inputTokens: 300, outputTokens: 250 }];
    const backend = buildBackend(stalledStream(false).stream);
    const turn = backend
      .complete(
        ChatModels.CLAUDE_4_5_SONNET,
        [{ role: 'user', content: 'hi' }],
        {
          stream: true,
          _internal: {
            enableIdleTimeout: true,
            accumInputTokens: 300,
            accumOutputTokens: 250,
            accumTurnUsage: priorTurns,
          },
        },
        async () => {}
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(31_000);

    expect(await turn).toMatchObject({
      kind: 'first_event',
      usage: { inputTokens: 300, outputTokens: 250, turnUsage: priorTurns },
    });
  });
});

const encoder = new TextEncoder();
const sse = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const PING = sse('ping', { type: 'ping' });

/**
 * A raw SSE body served through the SDK's `asResponse()` path, the way a real request is
 * consumed. The test pushes chunks by hand; aborting the request signal errors the body the way
 * a cancelled fetch does.
 */
function rawSseTurn(model: string, { abortSignal, maxTokens }: { abortSignal?: AbortSignal; maxTokens?: number } = {}) {
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  const signalState: { signal?: AbortSignal; maxTokens?: number } = {};
  const backend = new AnthropicBackend('test-key', makeLogger());
  type RawApiMock = {
    messages: { create: (params: { max_tokens?: number }, options: { signal?: AbortSignal }) => unknown };
  };
  (backend as unknown as { _api: RawApiMock })._api = {
    messages: {
      create: (params, options) => {
        signalState.signal = options.signal;
        signalState.maxTokens = params.max_tokens;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
        });
        options.signal?.addEventListener('abort', () => {
          const error = new Error('Request was aborted.');
          error.name = 'AbortError';
          body?.error(error);
        });
        return { asResponse: async () => new Response(stream, { status: 200 }) };
      },
    },
  };
  const outcome: { settled: boolean; error?: Error } = { settled: false };
  const turn = backend
    .complete(
      model,
      [{ role: 'user', content: 'hi' }],
      { stream: true, abortSignal, maxTokens, _internal: { enableIdleTimeout: true } },
      async () => {}
    )
    .catch((error: unknown) => {
      outcome.error = error instanceof Error ? error : new Error(String(error));
    })
    .finally(() => {
      outcome.settled = true;
    });
  return {
    turn,
    outcome,
    push: (chunk: Uint8Array) => body?.enqueue(chunk),
    finish: () => {
      body?.enqueue(
        sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
      );
      body?.enqueue(sse('message_stop', { type: 'message_stop' }));
      body?.close();
    },
    isAborted: () => !!signalState.signal?.aborted,
    sentMaxTokens: () => signalState.maxTokens,
  };
}

describe('AnthropicBackend - keepalive pings and the idle timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
  });

  it('lets ping keepalives hold the idle timer off while the model is silent', async () => {
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_SONNET);
    await vi.advanceTimersByTimeAsync(0);
    turn.push(sse('message_start', messageStart));

    // 160s of silence apart from pings, past the 90s idle limit but under the 180s ceiling.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(40_000);
      turn.push(PING);
    }
    expect(turn.isAborted()).toBe(false);
    expect(turn.outcome.settled).toBe(false);

    turn.finish();
    await vi.advanceTimersByTimeAsync(0);
    await turn.turn;

    expect(turn.outcome.error).toBeUndefined();
  });

  it('cuts off a stream that only pings at twice the idle limit when max_tokens is small', async () => {
    // 4096 tokens at 50 tokens/s is 82s, under twice the 90s idle limit, so the 180s floor applies.
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_SONNET, { maxTokens: 4096 });
    await vi.advanceTimersByTimeAsync(0);
    turn.push(sse('message_start', messageStart));

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      turn.push(PING);
    }
    expect(turn.isAborted()).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    await turn.turn;

    expect(turn.sentMaxTokens()).toBe(4096);
    expect(turn.isAborted()).toBe(true);
    expect(turn.outcome.error).toMatchObject({
      name: 'LlmTimeoutError',
      kind: 'stream_idle',
      timeoutMs: 180_000,
      keepalive: true,
    });
  });

  it('stretches the ping ceiling to max_tokens at 50 tokens/s once an event has arrived', async () => {
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_SONNET, { maxTokens: 16_000 });
    await vi.advanceTimersByTimeAsync(0);
    turn.push(
      sse('message_start', {
        type: 'message_start',
        message: {
          usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 },
        },
      })
    );

    // 300s of pings: well past the old 180s ceiling, under the 320s that 16000 tokens allows.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      turn.push(PING);
    }
    expect(turn.sentMaxTokens()).toBe(16_000);
    expect(turn.isAborted()).toBe(false);

    await vi.advanceTimersByTimeAsync(21_000);
    await turn.turn;

    expect(turn.isAborted()).toBe(true);
    expect(turn.outcome.error).toBeInstanceOf(LlmTimeoutError);
    expect(turn.outcome.error).toMatchObject({
      kind: 'stream_idle',
      timeoutMs: 320_000,
      keepalive: true,
      usage: { inputTokens: 10, cacheReadInputTokens: 500, cacheCreationInputTokens: 20 },
    });
    expect(turn.outcome.error?.message).toContain('connection stayed alive');
  });

  it('clamps the max_tokens ceiling at 15 minutes so a hung generation still reaches the fallback', async () => {
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_OPUS, { maxTokens: 64_000 });
    await vi.advanceTimersByTimeAsync(0);
    turn.push(
      sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    );

    // 870s of pings: 64000 tokens at 50/s would allow 1280s, the clamp allows 900s.
    for (let i = 0; i < 29; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      turn.push(PING);
    }
    expect(turn.isAborted()).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    await turn.turn;

    expect(turn.isAborted()).toBe(true);
    expect(turn.outcome.error).toMatchObject({ kind: 'stream_idle', timeoutMs: 900_000, keepalive: true });
  });

  it('keeps twice the first-event limit for pings before any event, whatever max_tokens', async () => {
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_SONNET, { maxTokens: 16_000 });
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      turn.push(PING);
    }
    expect(turn.isAborted()).toBe(false);

    await vi.advanceTimersByTimeAsync(21_000);
    await turn.turn;

    expect(turn.isAborted()).toBe(true);
    // Nothing is generating before the first event, so this is not reported as keepalive.
    expect(turn.outcome.error).toMatchObject({ kind: 'first_event', timeoutMs: 60_000, keepalive: false });
  });

  it("cancels the request when the caller's abort signal fires", async () => {
    const userAbort = new AbortController();
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_SONNET, { abortSignal: userAbort.signal });
    await vi.advanceTimersByTimeAsync(0);
    turn.push(sse('message_start', messageStart));

    userAbort.abort();
    await vi.advanceTimersByTimeAsync(0);
    await turn.turn;

    expect(turn.isAborted()).toBe(true);
    expect(turn.outcome.error).toBeUndefined();
  });

  it('still times out a stream that sends nothing at all, pings included', async () => {
    // A large max_tokens only stretches the ceiling for pings; true silence still ends at the idle limit.
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_SONNET, { maxTokens: 16_000 });
    await vi.advanceTimersByTimeAsync(0);
    turn.push(sse('message_start', messageStart));

    await vi.advanceTimersByTimeAsync(89_000);
    expect(turn.isAborted()).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await turn.turn;

    expect(turn.isAborted()).toBe(true);
    expect(turn.outcome.error).toMatchObject({
      name: 'LlmTimeoutError',
      kind: 'stream_idle',
      timeoutMs: 90_000,
      keepalive: false,
      usage: { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
  });

  it('reports a stream that never sends its first event as a first_event timeout', async () => {
    const turn = rawSseTurn(ChatModels.CLAUDE_4_5_SONNET);

    await vi.advanceTimersByTimeAsync(31_000);
    await turn.turn;

    expect(turn.outcome.error).toMatchObject({ name: 'LlmTimeoutError', kind: 'first_event', timeoutMs: 30_000 });
  });
});
