import { afterEach, describe, it, expect, vi, type Mock } from 'vitest';
import { runCompletion, EmptyCompletionError, NoReplyCompletionError } from './runCompletion';
import { InMemoryStreamTransport, type ScriptedStep } from './InMemoryStreamTransport';
import { createTransientRetryPolicy } from './retryPolicy';
import type { CompletionRequest, RetryPolicy } from './streamTransport';
import type { StreamEvent } from './streamEvents';

vi.mock('../utils/Logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const req: CompletionRequest = { model: 'test-model', messages: [], options: {} };

const content = (text: string): StreamEvent => ({ type: 'content', text });
const toolUse = (name: string): StreamEvent => ({ type: 'tool_use', tools: [{ name, arguments: '{}', id: 't1' }] });

// Only 'boom' errors are retryable; instant retries so tests don't wait on backoff.
const policy = (maxRetries: number): RetryPolicy => ({
  maxRetries,
  isRetryable: e => e instanceof Error && e.message.includes('boom'),
  backoffMs: 0,
});

const run = (scripts: ScriptedStep[][], p: RetryPolicy, signal?: AbortSignal, controller?: AbortController) => {
  const transport = new InMemoryStreamTransport(scripts, controller);
  const callback = vi.fn().mockResolvedValue(undefined);
  return { transport, callback, promise: runCompletion(transport, req, callback, p, signal) };
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
    const { callback, promise } = run([[{ emit: content('hello ') }, { emit: content('world') }]], policy(2));
    await promise;
    // Trailing whitespace is held until more text follows; the second frame lands
    // inside the throttle window, so it rides the final frame.
    expect(callback.mock.calls).toEqual([[['hello']], [[' world'], expect.anything()]]);
    expect(finalFrames(callback)).toHaveLength(1);
  });

  it('throttles deltas to one per flush interval', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 30));
    const { callback, promise } = run(
      [[{ emit: content('a') }, { emit: content('b') }, { emit: content('c') }, { emit: content('d') }]],
      policy(2)
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
      policy(2)
    );
    await promise;
    expect(deliveredText(callback)).toBe('Answer');
  });

  it('accumulates a tool-use stream and finalizes once with the tool info', async () => {
    const { callback, promise } = run([[{ emit: toolUse('search') }]], policy(2));
    await promise;
    expect(callback).toHaveBeenCalledTimes(1);
    const [, info] = callback.mock.calls[0];
    expect(info.toolsUsed).toEqual([{ name: 'search', arguments: '{}', id: 't1' }]);
  });

  it('retries a failure that struck before any text was delivered (no double-append)', async () => {
    const { transport, callback, promise } = run(
      [[{ emit: toolUse('search') }, { fail: new Error('boom') }], [{ emit: content('full answer') }]],
      policy(2)
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
      [[{ emit: content('partial') }, { fail: new Error('boom') }], [{ emit: content('replayed') }]],
      policy(2)
    );
    await expect(promise).rejects.toThrow(/could not be retried automatically - type "continue" to resume/);
    expect(transport.attempts).toBe(1);
    expect(deliveredText(callback)).toBe('partial');
    expect(finalFrames(callback)).toHaveLength(0);
  });

  it('propagates a non-retryable error after streamed text unchanged', async () => {
    const { callback, promise } = run(
      [[{ emit: content('partial') }, { fail: new Error('Authentication failed') }]],
      policy(2)
    );
    await expect(promise).rejects.toThrow('Authentication failed');
    expect(finalFrames(callback)).toHaveLength(0);
  });

  it('retries only up to the limit, then surfaces the failure without delivering', async () => {
    const { transport, callback, promise } = run([[{ fail: new Error('boom') }]], policy(2));
    await expect(promise).rejects.toThrow(/type "continue" to resume/);
    expect(transport.attempts).toBe(3); // initial + 2 retries
    expect(callback).not.toHaveBeenCalled();
  });

  it('propagates a non-retryable error immediately with no retry', async () => {
    const { transport, callback, promise } = run([[{ fail: new Error('Authentication failed') }]], policy(2));
    await expect(promise).rejects.toThrow('Authentication failed');
    expect(transport.attempts).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('treats an empty stream as retryable, then surfaces EmptyCompletionError rather than a blank turn', async () => {
    const { transport, callback, promise } = run([[]], policy(1));
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
    const { transport, callback, promise } = run([[{ emit: content('') }, { emit: blankEnd }]], policy(2));
    await expect(promise).rejects.toThrow(/output limit on reasoning/);
    await expect(promise).rejects.toBeInstanceOf(NoReplyCompletionError);
    expect(transport.attempts).toBe(1); // one billed request, not three
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not retry a blank turn that finished at end_turn, and names the stop reason', async () => {
    // The no-retry rule is deliberately broad: any terminal stop reason means the
    // turn finished normally, so a retry would repeat (and re-bill) the same outcome.
    const blankEnd: StreamEvent = { type: 'content', text: '', stopReason: 'end_turn' };
    const { transport, callback, promise } = run([[{ emit: content('') }, { emit: blankEnd }]], policy(2));
    await expect(promise).rejects.toThrow(/stop reason: end_turn/);
    await expect(promise).rejects.toBeInstanceOf(NoReplyCompletionError);
    expect(transport.attempts).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not retry a blank turn whose stop reason reads as a transient network error', async () => {
    // 'aborted' is in the transient-network pattern list, so only the
    // NoReplyCompletionError guard stops this blank turn from being re-billed.
    const blankAborted: StreamEvent = { type: 'content', text: '', stopReason: 'aborted' };
    const realPolicy: RetryPolicy = { ...createTransientRetryPolicy(), backoffMs: 0 };
    const { transport, callback, promise } = run([[{ emit: content('') }, { emit: blankAborted }]], realPolicy);
    await expect(promise).rejects.toBeInstanceOf(NoReplyCompletionError);
    expect(transport.attempts).toBe(1);
    expect(callback).not.toHaveBeenCalled();
  });

  it('settles a mid-stream abort without invoking the callback when no text was delivered', async () => {
    const controller = new AbortController();
    const { callback, promise } = run(
      [[{ emit: toolUse('search') }, { abort: true }, { emit: content('never delivered') }]],
      policy(2),
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
      policy(2),
      controller.signal,
      controller
    );
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(deliveredText(callback)).toBe('partial');
    expect(finalFrames(callback)).toHaveLength(0);
  });

  it('recovers under the real policy when a retry races WebSocket auto-reconnect', async () => {
    // Attempt 1 opens before the socket has reconnected ("not connected"); the
    // real transient policy must treat that as retryable so attempt 2 recovers.
    const realPolicy: RetryPolicy = { ...createTransientRetryPolicy(), backoffMs: 0 };
    const { transport, callback, promise } = run(
      [[{ fail: new Error('WebSocket is not connected') }], [{ emit: content('recovered') }]],
      realPolicy
    );
    await promise;
    expect(transport.attempts).toBe(2);
    expect(deliveredText(callback)).toBe('recovered');
    expect(finalFrames(callback)).toHaveLength(1);
  });

  it('settles without opening the stream when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, callback, promise } = run([[{ emit: content('x') }]], policy(2), controller.signal);
    await expect(promise).resolves.toBeUndefined();
    expect(transport.attempts).toBe(0);
    expect(callback).not.toHaveBeenCalled();
  });
});
