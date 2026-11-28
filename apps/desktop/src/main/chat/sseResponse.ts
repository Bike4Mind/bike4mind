import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import { createParser } from 'eventsource-parser';
import { isAxiosError, type AxiosResponse } from 'axios';

/**
 * Reading a streamed (`responseType: 'stream'`) SSE response and a refused request's body. Shared
 * by the stateless completions stream (completions.ts) and the session turns stream
 * (webLinkedTurn.ts), which differ only in the events they decode.
 */

export class StreamIdleError extends Error {
  readonly code = 'ESTREAMIDLE';
  constructor(ms: number) {
    super(`no data for ${Math.round(ms / 1000)}s`);
  }
}

const DROP_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESTREAMIDLE']);

/** A transport failure of an open stream, as opposed to anything the server said. */
export function isConnectionDrop(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && DROP_CODES.has(code);
}

/**
 * Lift the client's request timeout off the socket once the stream is open.
 *
 * axios hands its `timeout` to follow-redirects, which sets it as the SOCKET's idle timeout with
 * `socket.destroy` as the handler, and clears only its own wall-clock timer when the response
 * arrives. Left alone, any gap that long between bytes of a reply - or an event loop held that
 * long - destroys the socket, and the stream fails with Node's bare "aborted". readSseResponse's
 * idle guard bounds the stream instead.
 */
export function releaseRequestTimeout(response: AxiosResponse): void {
  const request: unknown = response.request;
  if (!request || typeof request !== 'object' || !('socket' in request)) return;
  const socket: unknown = request.socket;
  if (socket && typeof socket === 'object' && 'setTimeout' in socket && typeof socket.setTimeout === 'function') {
    socket.setTimeout(0);
  }
}

export interface SseReadOptions {
  signal?: AbortSignal;
  /** How long the open stream may go without a byte before it is treated as dropped. In ms. */
  idleTimeoutMs: number;
  /**
   * One frame's `data`. Returning 'done' ends the read cleanly; returning an Error ends it with
   * that error. Anything else keeps reading.
   */
  onData: (data: string) => 'done' | Error | void;
  /** A transport failure (idle, socket error), reported once before the read rejects with it. */
  onTransportError?: (error: Error) => void;
}

/**
 * Resolves when the stream ends (`onData` says done, or the socket ends) or `signal` aborts;
 * rejects with what `onData` returned or with a transport failure.
 */
export function readSseResponse(response: AxiosResponse, options: SseReadOptions): Promise<void> {
  const { signal, idleTimeoutMs } = options;
  return new Promise<void>((resolve, reject) => {
    const stream = response.data as NodeJS.ReadableStream & { destroy(): void };
    let settled = false;

    let lastByteAt = Date.now();
    let idleTimer: NodeJS.Timeout | undefined;
    // Checked from setImmediate, after the poll phase: bytes that arrived while the event loop
    // was busy are read (and refresh lastByteAt) before the stream is judged idle.
    const armIdle = (delay: number) => {
      idleTimer = setTimeout(
        () =>
          setImmediate(() => {
            if (settled) return;
            const quiet = Date.now() - lastByteAt;
            if (quiet >= idleTimeoutMs) failTransport(new StreamIdleError(quiet));
            else armIdle(idleTimeoutMs - quiet);
          }),
        delay
      );
    };
    const cleanup = () => {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(error);
    };

    const failTransport = (error: Error) => {
      if (!settled) options.onTransportError?.(error);
      fail(error);
    };

    const parser = createParser({
      onEvent: sse => {
        if (settled) return;
        const outcome = options.onData(sse.data);
        if (outcome === 'done') finish();
        else if (outcome instanceof Error) fail(outcome);
      },
    });

    // A chunk boundary can land inside a multi-byte character; decoding each chunk alone would
    // turn both halves into U+FFFD.
    const decoder = new StringDecoder('utf8');
    const onData = (chunk: Buffer) => {
      lastByteAt = Date.now();
      if (signal?.aborted) return;
      parser.feed(decoder.write(chunk));
    };
    // Ending without [DONE] is still an end: the caller keeps whatever text arrived.
    const onEnd = () => finish();
    // A socket error caused by our own abort is benign; anything else is a real failure.
    const onError = (error: Error) => (signal?.aborted ? finish() : failTransport(error));
    const onAbort = () => finish();

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    armIdle(idleTimeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export interface ErrorBody {
  message?: string;
  /** The envelope's machine-readable classifier, when it carries one. */
  errorCode?: string;
}

/**
 * The failure response's own words, when it has any.
 *
 * `responseType: 'stream'` means a REJECTED request hands back a stream too, so without reading
 * it a 400 is only ever "status 400" - and the one thing a caller most needs to tell apart, a
 * context window that has run out, is only distinguishable from what the provider wrote.
 */
export async function readErrorBody(error: unknown): Promise<ErrorBody | undefined> {
  const text = await readErrorText(error);
  if (!text) return undefined;
  return { message: messageOf(text), errorCode: errorCodeOf(text) };
}

async function readErrorText(error: unknown): Promise<string | undefined> {
  if (!isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (typeof data === 'string') return data.slice(0, ERROR_BODY_LIMIT).trim();
  if (!data || typeof (data as Readable).on !== 'function') return undefined;

  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of data as Readable) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      if (size >= ERROR_BODY_LIMIT) break;
    }
    return Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_LIMIT).trim();
  } catch {
    return undefined;
  }
}

function errorCodeOf(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('errorCode' in parsed)) return undefined;
    return typeof parsed.errorCode === 'string' ? parsed.errorCode : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server wraps a provider failure in its own envelope; either shape may show up, and a body
 * that parses as neither is returned as written rather than dropped.
 */
function messageOf(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } | string };
    const message =
      typeof parsed.message === 'string'
        ? parsed.message
        : typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : undefined;
    return message ?? text;
  } catch {
    return text;
  }
}

/** Enough of a failure body to name the cause, and not enough to paste a page into a message. */
const ERROR_BODY_LIMIT = 2000;
