import { PassThrough } from 'node:stream';
import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { streamCompletion } from './completions';
import type { CompletionStreamEvent } from './streamEvents';

/** One SSE frame. The blank-line terminator is what the parser splits on. */
function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function fakeAxios(stream: PassThrough): { instance: AxiosInstance; post: ReturnType<typeof vi.fn> } {
  const post = vi.fn().mockResolvedValue({ data: stream, status: 200 });
  return { instance: { post } as unknown as AxiosInstance, post };
}

const REQUEST = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('streamCompletion', () => {
  it('decodes content frames in order and stops at [DONE]', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));

    stream.write(frame({ type: 'meta', requestId: 'r1' }));
    stream.write(frame({ type: 'content', text: 'Hel' }));
    stream.write(frame({ type: 'content', text: 'lo', stopReason: 'end_turn' }));
    stream.write(frame('[DONE]'));
    await done;

    expect(events.map(event => ('text' in event ? event.text : event.type))).toEqual(['meta', 'Hel', 'lo']);
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));

    const whole = frame({ type: 'content', text: 'split' });
    stream.write(whole.slice(0, 12));
    stream.write(whole.slice(12));
    stream.end();
    await done;

    expect(events).toEqual([{ type: 'content', text: 'split' }]);
  });

  it('resolves on socket end without [DONE], so a truncated stream keeps its text', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));
    stream.write(frame({ type: 'content', text: 'partial' }));
    stream.end();

    await expect(done).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
  });

  it('rejects with the server message on an in-band error event', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);

    const done = streamCompletion(instance, '/c', REQUEST, () => {});
    stream.write(frame({ type: 'error', message: 'insufficient credits' }));

    await expect(done).rejects.toThrow('insufficient credits');
  });

  it('skips a malformed frame rather than failing the rest of the reply', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event));
    stream.write('data: {oops\n\n');
    stream.write(frame({ type: 'content', text: 'still here' }));
    stream.write(frame('[DONE]'));
    await done;

    expect(events).toEqual([{ type: 'content', text: 'still here' }]);
  });

  it('treats an abort mid-stream as a normal end, keeping what arrived', async () => {
    const stream = new PassThrough();
    const { instance } = fakeAxios(stream);
    const controller = new AbortController();
    const events: CompletionStreamEvent[] = [];

    const done = streamCompletion(instance, '/c', REQUEST, event => events.push(event), controller.signal);
    stream.write(frame({ type: 'content', text: 'half a th' }));
    // The frame has to be delivered before aborting, or this asserts on an abort that raced
    // the stream's first 'data' event rather than on one that interrupted a live reply.
    await vi.waitUntil(() => events.length === 1, { timeout: 2000, interval: 5 });
    controller.abort();

    await expect(done).resolves.toBeUndefined();
    expect(events).toEqual([{ type: 'content', text: 'half a th' }]);
  });

  it('never opens a request that was aborted before it started', async () => {
    const { instance, post } = fakeAxios(new PassThrough());
    const controller = new AbortController();
    controller.abort();

    await streamCompletion(instance, '/c', REQUEST, () => {}, controller.signal);
    expect(post).not.toHaveBeenCalled();
  });

  it('asks for a stream and declares no tools, since it runs no tool loop', async () => {
    const stream = new PassThrough();
    const { instance, post } = fakeAxios(stream);

    const done = streamCompletion(instance, '/c', REQUEST, () => {});
    stream.write(frame('[DONE]'));
    await done;

    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('/c');
    expect(body).toMatchObject({ model: 'm', options: { stream: true } });
    expect(body.options.tools).toBeUndefined();
    expect(config.responseType).toBe('stream');
  });

  it('names an expired session on a 401 instead of leaking a bare status', async () => {
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 401 },
      })
    );
    const instance = { post } as unknown as AxiosInstance;

    await expect(streamCompletion(instance, '/c', REQUEST, () => {})).rejects.toThrow(/session may have expired/);
  });
});
