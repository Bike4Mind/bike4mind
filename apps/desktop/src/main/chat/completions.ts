import type { Readable } from 'node:stream';
import { createParser } from 'eventsource-parser';
import { isAxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import type { ChatModelOption, ChatRole } from '@shared/chat';
import { parseStreamEvent, type CompletionStreamEvent } from './streamEvents';

/** Same-origin default; a self-host stack overrides it with `sseCompletionsUrl` from serverConfig. */
export const DEFAULT_COMPLETIONS_PATH = '/api/ai/v1/completions';

/**
 * `content` is a string for an ordinary turn, or an array of provider-shaped blocks
 * (`tool_use`, `tool_result`, reasoning) when a turn carries tool traffic. The endpoint
 * accepts both - see CompletionMessageSchema in @bike4mind/common.
 */
export interface CompletionMessage {
  role: ChatRole | 'system';
  content: string | unknown[];
  /** Asks the provider to cache the request up to and including this message. Anthropic only. */
  cache?: boolean;
}

/**
 * Whether `model` can be sent `cache: true`. Only direct Anthropic turns the flag into
 * `cache_control`; the Bedrock backend forwards it as a raw field on the message body, which
 * Bedrock may reject, and other providers gain nothing from it. An unknown model - a catalog
 * that could not be read, or one with no backend named - is treated as not cacheable, because a
 * stray field failing every request is worse than paying full price.
 */
export function supportsPromptCache(models: readonly ChatModelOption[], model: string): boolean {
  return models.find(option => option.id === model)?.backend === 'anthropic';
}

/** Anthropic rejects `cache_control` on these, and the adapter stamps whatever block is last. */
const UNCACHEABLE_BLOCKS = new Set(['thinking', 'redacted_thinking']);

function canCarryBreakpoint(message: CompletionMessage): boolean {
  if (typeof message.content === 'string') return message.content.trim() !== '';
  const tail = message.content[message.content.length - 1];
  const type = tail && typeof tail === 'object' ? (tail as { type?: unknown }).type : undefined;
  return message.content.length > 0 && !(typeof type === 'string' && UNCACHEABLE_BLOCKS.has(type));
}

/**
 * The messages as one request should send them: a copy of the system message and of the last
 * message that can carry a breakpoint, marked `cache: true`, the rest untouched. The first
 * breakpoint caches the tools and system prompt, which are stable across a whole turn; the
 * second is a rolling one, so the next request reads everything up to it from cache instead of
 * re-billing it.
 *
 * The rolling one skips back past a message that ends on a reasoning block. In a tool loop the
 * last message is a user turn of tool results, so that is a guard rather than a common path.
 *
 * Copies, never the caller's own messages: a stamp left on a stored message would pile up into a
 * breakpoint per round and trip the provider's limit of four.
 */
export function withCacheBreakpoints(messages: readonly CompletionMessage[]): CompletionMessage[] {
  let rolling = messages.length - 1;
  while (rolling >= 0 && !canCarryBreakpoint(messages[rolling])) rolling--;
  return messages.map((message, index) =>
    index === rolling || message.role === 'system' ? { ...message, cache: true } : message
  );
}

export interface CompletionRequest {
  model: string;
  messages: CompletionMessage[];
  /** Declared tools. The model may ASK for these; running them is this client's job. */
  tools?: { toolSchema: unknown }[];
  /** Output ceiling for the reply. Absent lets the server choose, which is 4096 for most models. */
  maxTokens?: number;
  /**
   * Ask for the model's reasoning as readable text. An adaptive model reasons either way; without
   * this it comes back empty. A server that predates the option ignores it.
   */
  thinking?: boolean;
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
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        // The tool loop on this endpoint belongs to the CALLER: the model emits tool_use and
        // this client executes it locally, then sends the result back as another turn.
        options: {
          stream: true,
          tools: request.tools ?? [],
          ...(request.thinking ? { thinking: { enabled: true } } : {}),
        },
      },
      { responseType: 'stream', signal }
    );
  } catch (err) {
    if (signal?.aborted || (isAxiosError(err) && err.code === 'ERR_CANCELED')) return;
    throw toRequestError(err, await readErrorBody(err));
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
function toRequestError(error: unknown, body?: string): Error {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      return new Error(`The server refused the request (${status}). Your session may have expired.`);
    }
    if (status) {
      return new Error(body ? `${body} (status ${status})` : `The completion request failed with status ${status}.`);
    }
    if (error.code === 'ECONNREFUSED') {
      return new Error('Cannot reach the Bike4Mind server. Check the environment and your connection.');
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The failure response's own words, when it has any.
 *
 * `responseType: 'stream'` means a REJECTED request hands back a stream too, so without reading
 * it a 400 is only ever "status 400" - and the one thing a caller most needs to tell apart, a
 * context window that has run out, is only distinguishable from what the provider wrote.
 */
async function readErrorBody(error: unknown): Promise<string | undefined> {
  if (!isAxiosError(error)) return undefined;
  const data = error.response?.data;
  if (typeof data === 'string') return data.slice(0, ERROR_BODY_LIMIT) || undefined;
  if (!data || typeof (data as Readable).on !== 'function') return undefined;

  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of data as Readable) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      if (size >= ERROR_BODY_LIMIT) break;
    }
    const text = Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_LIMIT).trim();
    if (!text) return undefined;
    // The server wraps a provider failure in its own envelope; either shape may show up, and a
    // body that parses as neither is returned as written rather than dropped.
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
  } catch {
    return undefined;
  }
}

/** Enough of a failure body to name the cause, and not enough to paste a page into a message. */
const ERROR_BODY_LIMIT = 2000;
