import { ModelCallError } from './modelCallError';

/**
 * How long (ms) a completion stream may go without a single byte before it is treated as dead.
 * The server writes a keep-alive comment every 10 s (sseRoute.ts), so silence this long means a
 * half-open connection, not a model that is thinking.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

/** `B4M_STREAM_IDLE_TIMEOUT_MS` overrides the default; `0` turns the watchdog off. */
export function resolveStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.B4M_STREAM_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * Re-expose `body` so a read that waits longer than `idleMs` for the next chunk errors with a
 * `stream_idle` {@link ModelCallError} and cancels the source. The clock runs only while the
 * consumer is waiting, so a slow consumer is never mistaken for a silent server.
 */
export function withIdleTimeout(body: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const idle = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new ModelCallError('stream_idle', `No data from the server for ${Math.round(idleMs / 1000)}s`)),
            idleMs
          );
        });
        try {
          const { done, value } = await Promise.race([reader.read(), idle]);
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          // The source may already be errored; how its cancel settles changes nothing here.
          reader.cancel(error).catch(() => undefined);
        } finally {
          clearTimeout(timer);
        }
      },
      cancel(reason) {
        clearTimeout(timer);
        return reader.cancel(reason);
      },
    }, // No read-ahead: pull (and the clock) runs only while a consumer is waiting.
    { highWaterMark: 0 }
  );
}

/** Wrap a `fetch` so every `text/event-stream` response body gets {@link withIdleTimeout}. */
export function fetchWithStreamIdleTimeout(fetchImpl: typeof fetch, idleMs: number): typeof fetch {
  if (idleMs <= 0) return fetchImpl;
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    const isEventStream = /text\/event-stream/i.test(response.headers.get('content-type') ?? '');
    if (!response.body || !isEventStream) return response;
    return new Response(withIdleTimeout(response.body, idleMs), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
