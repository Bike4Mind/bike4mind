import { createParser } from 'eventsource-parser';

/**
 * Yield each server-sent event's `data` from a fetch body, until `[DONE]`, the end of the stream, or `signal`
 * aborts (which throws the signal's reason). Breaking out of the loop early cancels the body.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const queue: string[] = [];
  const parser = createParser({ onEvent: event => queue.push(event.data) });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // Cancelling resolves a pending read() with done, so the abort check below runs instead of hanging.
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      parser.feed(done ? decoder.decode() : decoder.decode(value, { stream: true }));
      while (queue.length > 0) {
        const data = queue.shift() as string;
        if (data === '[DONE]') return;
        yield data;
      }
      if (done) {
        finished = true;
        return;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) await reader.cancel().catch(() => {});
  }
}
