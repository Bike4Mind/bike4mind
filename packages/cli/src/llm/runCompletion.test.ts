import { describe, it, expect, vi } from 'vitest';
import { runCompletion, EmptyCompletionError } from './runCompletion';
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

describe('runCompletion', () => {
  it('delivers a completed stream exactly once', async () => {
    const { callback, promise } = run([[{ emit: content('hello ') }, { emit: content('world') }]], policy(2));
    await promise;
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(['hello world'], expect.anything());
  });

  it('accumulates a tool-use stream and finalizes once with the tool info', async () => {
    const { callback, promise } = run([[{ emit: toolUse('search') }]], policy(2));
    await promise;
    expect(callback).toHaveBeenCalledTimes(1);
    const [, info] = callback.mock.calls[0];
    expect(info.toolsUsed).toEqual([{ name: 'search', arguments: '{}', id: 't1' }]);
  });

  it('retries a mid-stream failure and delivers the completion exactly once (no double-append)', async () => {
    const { transport, callback, promise } = run(
      [[{ emit: content('partial') }, { fail: new Error('boom') }], [{ emit: content('full answer') }]],
      policy(2)
    );
    await promise;
    expect(transport.attempts).toBe(2);
    expect(callback).toHaveBeenCalledTimes(1);
    // The discarded attempt's 'partial' never reaches the callback.
    expect(callback).toHaveBeenCalledWith(['full answer'], expect.anything());
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

  it('settles a mid-stream abort without invoking the callback', async () => {
    const controller = new AbortController();
    const { callback, promise } = run(
      [[{ emit: content('partial') }, { abort: true }, { emit: content('never delivered') }]],
      policy(2),
      controller.signal,
      controller
    );
    await expect(promise).resolves.toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
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
    expect(callback).toHaveBeenCalledWith(['recovered'], expect.anything());
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
