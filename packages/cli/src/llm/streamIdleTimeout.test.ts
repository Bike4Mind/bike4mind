import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  fetchWithStreamIdleTimeout,
  resolveStreamIdleTimeoutMs,
  withIdleTimeout,
} from './streamIdleTimeout';

const bytes = (text: string) => new TextEncoder().encode(text);

/** A body the test feeds by hand; `cancelled` records the reason the watchdog cancels it with. */
function manualBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel: cancelled,
  });
  return { body, controller, cancelled };
}

describe('withIdleTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('errors with stream_idle and cancels the source after idleMs of silence', async () => {
    vi.useFakeTimers();
    const { body, controller, cancelled } = manualBody();
    const reader = withIdleTimeout(body, 1_000).getReader();
    controller.enqueue(bytes('a'));
    expect((await reader.read()).value).toEqual(bytes('a'));

    const next = reader.read();
    const outcome = expect(next).rejects.toMatchObject({ name: 'ModelCallError', kind: 'stream_idle' });
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(cancelled).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stream_idle' }));
  });

  it('restarts the clock on every chunk', async () => {
    vi.useFakeTimers();
    const { body, controller } = manualBody();
    const reader = withIdleTimeout(body, 1_000).getReader();
    for (const text of ['a', 'b', 'c']) {
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(900);
      controller.enqueue(bytes(text));
      expect((await next).value).toEqual(bytes(text));
    }
    controller.close();
    expect((await reader.read()).done).toBe(true);
  });

  it('does not count time the consumer spends away from the stream', async () => {
    vi.useFakeTimers();
    const { body, controller } = manualBody();
    const reader = withIdleTimeout(body, 1_000).getReader();
    controller.enqueue(bytes('a'));
    await reader.read();
    await vi.advanceTimersByTimeAsync(5_000);
    controller.enqueue(bytes('b'));
    expect((await reader.read()).value).toEqual(bytes('b'));
  });

  it('passes a source error through unchanged', async () => {
    const { body, controller } = manualBody();
    const reader = withIdleTimeout(body, 1_000).getReader();
    const drop = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    controller.error(drop);
    await expect(reader.read()).rejects.toBe(drop);
  });
});

describe('fetchWithStreamIdleTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const respondWith = (response: Response) => vi.fn<typeof fetch>(async () => response);

  it('guards an event-stream body', async () => {
    vi.useFakeTimers();
    const { body } = manualBody();
    const fetchImpl = respondWith(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await fetchWithStreamIdleTimeout(fetchImpl, 1_000)('http://x');
    const read = response.body!.getReader().read();
    const outcome = expect(read).rejects.toMatchObject({ kind: 'stream_idle' });
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
  });

  it('leaves a non-stream response as is', async () => {
    const original = new Response('{"error":"nope"}', { status: 422, headers: { 'content-type': 'application/json' } });
    const response = await fetchWithStreamIdleTimeout(respondWith(original), 1_000)('http://x');
    expect(response).toBe(original);
  });

  it('is a no-op when disabled', () => {
    const fetchImpl = respondWith(new Response(''));
    expect(fetchWithStreamIdleTimeout(fetchImpl, 0)).toBe(fetchImpl);
  });
});

describe('resolveStreamIdleTimeoutMs', () => {
  it.each([
    [undefined, DEFAULT_STREAM_IDLE_TIMEOUT_MS],
    ['', DEFAULT_STREAM_IDLE_TIMEOUT_MS],
    ['30000', 30_000],
    ['0', 0],
    ['-5', DEFAULT_STREAM_IDLE_TIMEOUT_MS],
    ['soon', DEFAULT_STREAM_IDLE_TIMEOUT_MS],
  ])('reads %j as %d', (value, expected) => {
    expect(resolveStreamIdleTimeoutMs({ B4M_STREAM_IDLE_TIMEOUT_MS: value })).toBe(expected);
  });
});
