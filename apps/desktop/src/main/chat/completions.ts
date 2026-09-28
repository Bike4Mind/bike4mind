import { createParser } from 'eventsource-parser';
import { isAxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import type { ChatRole } from '@shared/chat';
import { parseStreamEvent, type CompletionStreamEvent } from './streamEvents';

/** Same-origin default; a self-host stack overrides it with `sseCompletionsUrl` from serverConfig. */
export const DEFAULT_COMPLETIONS_PATH = '/api/ai/v1/completions';

export interface CompletionMessage {
  role: ChatRole | 'system';
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: CompletionMessage[];
}

/**
 * Stream one completion, calling `onEvent` for each decoded SSE event.
 *
 * Resolves when the stream ends cleanly (`[DONE]` or socket end) or when `signal` aborts -
 * an abort is a normal outcome here, since stopping a reply is a user action, not a failure.
 * Rejects on a pre-stream HTTP failure or a mid-stream socket error.
 *
 * Callback-based rather than an async iterable because every consumer forwards straight to an
 * IPC push, which cannot exert backpressure anyway.
 */
export async function streamCompletion(
  axiosInstance: AxiosInstance,
  endpoint: string,
  request: CompletionRequest,
  onEvent: (event: CompletionStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return;

  let response: AxiosResponse;
  try {
    response = await axiosInstance.post(
      endpoint,
      {
        model: request.model,
        messages: request.messages,
        // No `tools`: the agent/tool loop on this endpoint is the CALLER's to run (the model
        // emits tool_use and the client executes), and this client does not run one.
        options: { stream: true },
      },
      { responseType: 'stream', signal }
    );
  } catch (err) {
    if (signal?.aborted || (isAxiosError(err) && err.code === 'ERR_CANCELED')) return;
    throw toRequestError(err);
  }

  await readSseStream(response, onEvent, signal);
}

function readSseStream(
  response: AxiosResponse,
  onEvent: (event: CompletionStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = response.data as NodeJS.ReadableStream & { destroy(): void };
    let settled = false;

    const cleanup = () => {
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

    const parser = createParser({
      onEvent: sse => {
        if (sse.data === '[DONE]') {
          finish();
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(sse.data);
        } catch {
          // A malformed frame is skipped rather than fatal: the rest of the reply is still good.
          return;
        }
        const event = parseStreamEvent(decoded);
        if (!event) return;
        if (event.type === 'error') {
          fail(new Error(event.message || 'The server reported an error mid-reply.'));
          return;
        }
        onEvent(event);
      },
    });

    const onData = (chunk: Buffer) => {
      if (signal?.aborted) return;
      parser.feed(chunk.toString('utf8'));
    };
    // Ending without [DONE] is still an end: the caller keeps whatever text arrived.
    const onEnd = () => finish();
    // A socket error caused by our own abort is benign; anything else is a real failure.
    const onError = (error: Error) => (signal?.aborted ? finish() : fail(error));
    const onAbort = () => finish();

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Turn a pre-stream failure into a message worth showing. The HTML case is not hypothetical:
 * a proxy or WAF sitting in front of the completions service answers with an error page, and
 * the raw axios message for that is just a status code.
 */
function toRequestError(error: unknown): Error {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return new Error(`The server refused the request (${status}). Your session may have expired.`);
    }
    if (status) {
      return new Error(`The completion request failed with status ${status}.`);
    }
    if (error.code === 'ECONNREFUSED') {
      return new Error('Cannot reach the Bike4Mind server. Check the environment and your connection.');
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}
