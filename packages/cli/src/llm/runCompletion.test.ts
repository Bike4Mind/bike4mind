import { afterEach, describe, it, expect, vi, type Mock } from 'vitest';
import { runCompletion, NoReplyCompletionError } from './runCompletion';
import { InMemoryStreamTransport, type ScriptedStep } from './InMemoryStreamTransport';
import { ModelCallError } from './modelCallError';
import { decideRetry, EmptyCompletionError, type RetryDecider } from './retryDecision';
import type { CompletionRequest } from './streamTransport';
import type { StreamEvent } from './streamEvents';

vi.mock('../utils/Logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Live text on, as the TUI requests it; the opt-out path has its own test.
const req: CompletionRequest = { model: 'test-model', messages: [], options: { streamText: true } };

const content = (text: string): StreamEvent => ({ type: 'content', text });
const toolUse = (name: string): StreamEvent => ({ type: 'tool_use', tools: [{ name, arguments: '{}', id: 't1' }] });

/** A dropped connection: retryable under the real decision. */
const drop = () => new ModelCallError('network', 'boom');

/** The real classification, capped at `maxRetries` and with no wait, so tests don't sit through backoff. */
const retryUpTo =
  (maxRetries: number): RetryDecider =>
  (error, attempt) =>
    attempt < maxRetries && decideRetry(error, 0).retry ? { retry: true, delayMs: 0 } : { retry: false };

const run = (
  scripts: ScriptedStep[][],
  decide: RetryDecider,
  signal?: AbortSignal,
  controller?: AbortController,
  request: CompletionRequest = req
) => {
  const transport = new InMemoryStreamTransport(scripts, controller);
  const callback = vi.fn().mockResolvedValue(undefined);
  return { transport, callback, promise: runCompletion(transport, request, callback, signal, decide) };
};

/** All text the callback received, in order: what the agent concatenates into its reply. */
const deliveredText = (callback: Mock) => callback.mock.calls.map(([texts]) => texts.join('')).join('');
/** Calls that carried completion info: the finalize frame, which must happen exactly once. */
const finalFrames = (callback: Mock) => callback.mock.calls.filter(([, info]) => info !== undefined);

describe('runCompletion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('streams the first text immediately, then finalizes the rest exactly once', async () => {
    const { callback, promise } = run([[{ emit: content('hello ') }, { emit: content('world') }]], retryUpTo(2));
    await promise;
    // Trailing whitespace is held until more text follows; the second frame lands
    // inside the throttle window, so it rides the final frame.
    expect(callback.mock.calls).toEqual([[['hello']], [[' world'], expect.anything()]]);
    expect(finalFrames(callback)).toHaveLength(1);
  });

  it('buffers the whole turn and keeps retrying when the caller did not ask for live text', async () => {
    const { transport, callback, promise } = run(
      [[{ emit: content('partial') }, { fail: drop() }], [{ emit: content('full answer') }]],
      retryUpTo(2),
      undefined,
      undefined,
      { ...req, options: {} }
    );
    await promise;
    expect(transport.attempts).toBe(2);
    expect(callback.mock.calls).toEqual([[['full answer'], expect.anything()]]);
  });

  it('throttles deltas to one per flush interval', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 30));
    const { callback, promise } = run(
      [[{ emit: content('a') }, { emit: content('b') }, { emit: content('c') }, { emit: content('d') }]],
      retryUpTo(2)
    );
    await promise;
    // 30 ms between frames: 'a' flushes at once, 'b' is 30 ms later (held), 'c' is
    // 60 ms after the last flush and takes 'bc' with it, 'd' rides the final frame.
    expect(callback.mock.calls.map(([texts]) => texts)).toEqual([['a'], ['bc'], ['d']]);
    expect(deliveredText(callback)).toBe('abcd');
  });

  it('strips thinking blocks from streamed text', async () => {
    const { callback, promise } = run(
      [[{ emit: content('<think>plan') }, { emit: content('</think>Answer') }]],
      retryUpTo(2)
    );
    await promise;
    expect(deliveredText(callback)).toBe('Answer');
  });

  it('accumulates a tool-use stream and finalizes once with the tool info', async () => {
    const { callback, promise } = run([[{ emit: toolUse('search') }]], retryUpTo(2));
    await promise;
    expect(callback).toHaveBeenCalledTimes(1);
    const [, info] = callback.mock.calls[0];
    expect(info.toolsUsed).toEqual([{ name: 'search', arguments: '{}', id: 't1' }]);
  });

  it('retries a failure that struck before any text was delivered (no double-append)', async () => {
    const { transport, callback, promise } = run(
      [[{ emit: toolUse('search') }, { fail: drop() }], [{ emit: content('full answer') }]],
      retryUpTo(2)
    );
    await promise;
    expect(transport.attempts).toBe(2);
    expect(deliveredText(callback)).toBe('full answer');
    // The discarded attempt's tool call never reaches the callback.
    expect(finalFrames(callback)).toHaveLength(1);
    expect(finalFrames(callback)[0][1].toolsUsed).toBeUndefined();
  });

  it('does not retry once text was streamed, and says how to resume', async () => {
    const { transport, callback, promise } = run(
      [[{ emit: content('partial') }, { fail: drop() }], [{ emit: content('replayed') }]],
      retryUpTo(2)
    );
    await expect(promise).rejects.toThrow(/could not be retried automatically - type "continue" to resume/);
    expect(transport.attempts).toBe(1);
    expect(deliveredText(callback)).toBe('partial');
    expect(finalFrames(callback)).toHaveLength(0);
  });

  it('propagates a non-retryable error after streamed text unchanged', async () => {
    const { callback, promise } = run(
      [[{ emit: content('partial') }, { fail: new Error('Authentication failed') }]],
      retryUpTo(2)
    );
    await expect(promise).rejects.toThrow('Authentication failed');
    expect(finalFrames(callback)).toHaveLength(0);
  });

  it('retries only up to the limit, then surfaces the failure without delivering', async () => {
    const { transport, callback, promise } = run([[{ fail: drop() }]], retryUpTo(2));
    await expect(promise).rejects.toThrow(/type "continue" to resume/);
    expect(transport.attempts).toBe(3); // initial + 2 retries
    expect(callback).not.toHaveBeenCalled();
  });

  it('propagates a non-retryable error immediately with no retry', async () => {
    const { transport, callback, promise } = run([[{ fail: new Error('Authentication failed') }]], retryUpTo(2));
    await expect(promise).rejects.toThrow('Authentication failed');
    expect(transport.attempts).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('treats an empty stream as retryable, then surfaces EmptyCompletionError rather than a blank turn', async () => {
    const { transport, callback, promise } = run([[]], retryUpTo(1));
    await expect(promise).rejects.toBeInstanceOf(EmptyCompletionError);
    expect(transport.attempts).toBe(2); // retried before giving up
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not retry a blank turn that finished at max_tokens, and says why', async () => {
    // A reasoning model that spent the whole budget thinking: every frame is blank.
    const blankEnd: StreamEvent = {
      type: 'content',
      text: '',
      usage: { outputTokens: 4096 },
      stopReason: 'max_tokens',
    };
    const { transport, callback, promise } = run([[{ emit: content('') }, { emit: blankEnd }]], retryUpTo(2));
    await expect(promise).rejects.toThrow(/output limit on reasoning/);
    await expect(promise).rejects.toBeInstanceOf(NoReplyCompletionError);
    expect(transport.attempts).toBe(1); // one billed request, not three
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not retry a blank turn that finished at end_turn, and names the stop reason', async () => {
    // The no-retry rule is deliberately broad: any terminal stop reason means the
    // turn finished normally, so a retry would repeat (and re-bill) the same outcome.
    const blankEnd: StreamEvent = { type: 'content', text: '', stopReason: 'end_turn' };
    const { transport, callback, promise } = run([[{ emit: content('') }, { emit: blankEnd }]], retryUpTo(2));
    await expect(promise).rejects.toThrow(/stop reason: end_turn/);
    await expect(promise).rejects.toBeInstanceOf(NoReplyCompletionError);
    expect(transport.attempts).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('settles a mid-stream abort without invoking the callback when no text was delivered', async () => {
    const controller = new AbortController();
    const { callback, promise } = run(
      [[{ emit: toolUse('search') }, { abort: true }, { emit: content('never delivered') }]],
      retryUpTo(2),
      controller.signal,
      controller
    );
    await expect(promise).resolves.toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects with an AbortError on abort after streamed text, so the partial reply is not kept', async () => {
    const controller = new AbortController();
    const { callback, promise } = run(
      [[{ emit: content('partial') }, { abort: true }, { emit: content('never delivered') }]],
      retryUpTo(2),
      controller.signal,
      controller
    );
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(deliveredText(callback)).toBe('partial');
    expect(finalFrames(callback)).toHaveLength(0);
  });

  it('settles without opening the stream when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, callback, promise } = run([[{ emit: content('x') }]], retryUpTo(2), controller.signal);
    await expect(promise).resolves.toBeUndefined();
    expect(transport.attempts).toBe(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it('passes each failed attempt number to the decision', async () => {
    const decide = vi.fn<RetryDecider>(() => ({ retry: true, delayMs: 0 }));
    const { promise } = run([[{ fail: drop() }], [{ fail: drop() }], [{ emit: content('ok') }]], decide);
    await promise;
    expect(decide.mock.calls.map(([, attempt]) => attempt)).toEqual([0, 1]);
  });

  describe('backoff', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits the decided delay before re-opening the stream', async () => {
      vi.useFakeTimers();
      const { transport, callback, promise } = run([[{ fail: drop() }], [{ emit: content('ok') }]], () => ({
        retry: true,
        delayMs: 1_000,
      }));
      await vi.advanceTimersByTimeAsync(999);
      expect(transport.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await promise;
      expect(transport.attempts).toBe(2);
      expect(deliveredText(callback)).toBe('ok');
    });

    it('settles at once, without another attempt, when aborted during the wait', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const { transport, callback, promise } = run(
        [[{ fail: drop() }], [{ emit: content('never') }]],
        () => ({ retry: true, delayMs: 60_000 }),
        controller.signal
      );
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await expect(promise).resolves.toBeUndefined();
      expect(transport.attempts).toBe(1);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
