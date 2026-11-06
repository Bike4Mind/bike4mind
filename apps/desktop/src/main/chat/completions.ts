import { StringDecoder } from 'node:string_decoder';
import { LOOP_RUN_HEADER } from '@bike4mind/common';
import type { Readable } from 'node:stream';
import { createParser } from 'eventsource-parser';
import { isAxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import { isToolChangeMessage, type PromptCacheTtl, type ReasoningEffort } from '@bike4mind/common';
import type { ChatModelOption, ChatRole } from '@shared/chat';
import type { GenerationSettings } from '@shared/generation';
import { devLog } from '../devlog/DevLogSink';
import { CHAT_STREAM_TAG } from './devLogTag';
import { parseStreamEvent, type CompletionStreamEvent } from './streamEvents';

/** Same-origin default; a self-host stack overrides it with `sseCompletionsUrl` from serverConfig. */
export const DEFAULT_COMPLETIONS_PATH = '/api/ai/v1/completions';

/**
 * How long the completion POST waits for response headers (ms), overriding the shared client's
 * 30 s. The server holds its headers until auth, model resolution and the credit hold are done,
 * so a cold start or a queued request can take well past 30 s before any byte arrives. It does
 * not cap total reply length, but axios also keeps it as a socket idle limit after headers, so a
 * silent gap this long mid-reply still aborts the stream.
 */
export const COMPLETION_HEADER_TIMEOUT_MS = 120_000;

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
  /**
   * A user message that belongs to the turn before it (tool screenshots), so local history
   * trimming never starts a turn here. Never sent: streamCompletion and OllamaLocal drop it.
   */
  continuesTurn?: boolean;
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
 * The previous request's rolling breakpoint, when that request ended on a tool change: the API looks
 * back only 20 blocks for an earlier entry, and one block per added tool can push it out of reach
 * (measured live), so it is marked again and read exactly. -1 when there is none.
 */
function lookbackBreakpoint(messages: readonly CompletionMessage[], rolling: number): number {
  let change = rolling - 1;
  while (change > 0 && !isToolChangeMessage(messages[change])) change--;
  if (change <= 0) return -1;
  const replies = messages.slice(change + 1, rolling).filter(message => message.role === 'assistant').length;
  return replies === 1 && canCarryBreakpoint(messages[change - 1]) ? change - 1 : -1;
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
  // A tool change message takes no breakpoint: the provider puts it on the turn before it.
  while (rolling >= 0 && (isToolChangeMessage(messages[rolling]) || !canCarryBreakpoint(messages[rolling]))) {
    rolling--;
  }
  const lookback = lookbackBreakpoint(messages, rolling);
  return messages.map((message, index) =>
    index === rolling || index === lookback || (message.role === 'system' && !isToolChangeMessage(message))
      ? { ...message, cache: true }
      : message
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
  /** Lowers or raises how long a reasoning model thinks before its first token. Absent sends nothing. */
  reasoningEffort?: ReasoningEffort;
  /**
   * The conversation's overrides that the model's controls list (see requestGeneration); the output
   * ceiling travels as `maxTokens`. Each transport sends what its backend takes. A conversation's
   * turns only: titles, suggestions and compaction never set it.
   */
  generation?: Omit<GenerationSettings, 'maxOutputTokens'>;
  /** Prompt-cache lifetime the server's breakpoints take. Absent sends nothing, which is '5m'. */
  cacheTtl?: PromptCacheTtl;
  /**
   * Which conversation this request belongs to. Sent so the server's credit ledger can tie the
   * spend to it, and tags the developer log. Absent for the requests that are not a
   * conversation's turn, such as naming a session.
   */
  sessionId?: string;
  /** Set when the tools were left out because the model's fixed context cannot hold them: Desktop's prompt plus tools. */
  toolPromptTokens?: number;
  /**
   * The loop run this request works for, sent as LOOP_RUN_HEADER so the server counts its credits
   * against the loop's daily budget. Set only in a loop runner session.
   */
  loopRunId?: string;
  /** Set when the tools were left out because the listed model reports no tool support. */
  toolsUnsupported?: true;
}

/** The contract's header; the server adds the call's credits to that loop run. */
export { LOOP_RUN_HEADER };

/**
 * Stream one completion, calling `onEvent` for each decoded SSE event.
 *
 * Resolves when the stream ends cleanly (`[DONE]` or socket end) or when `signal` aborts -
 * an abort is a normal outcome here, since stopping a reply is a user action, not a failure.
 * Rejects on a pre-stream HTTP failure or a mid-stream socket error.
 *
 * A dropped connection is never retried: the server keeps generating after the client goes
 * away, so a second request could bill a second completion or replay a server-side tool.
 *
 * Callback-based rather than an async iterable because every consumer forwards straight to an
 * IPC push, which cannot exert backpressure anyway.
 */
export async function streamCompletion(
  axiosInstance: AxiosInstance,
  endpoint: string,
  request: CompletionRequest,
  onEvent: (event: CompletionStreamEvent) => void,
  signal?: AbortSignal,
  options: StreamOptions = {}
): Promise<void> {
  try {
    await streamOnce(axiosInstance, endpoint, request, onEvent, signal, options);
  } catch (err) {
    if (!isConnectionDrop(err)) throw err;
    if (signal?.aborted) return;
    throw new Error(`The connection to the server dropped before the reply finished (${err.message}).`);
  }
}

export interface StreamOptions {
  /** How long the open stream may go without a byte before it is treated as dropped. In ms. */
  idleTimeoutMs?: number;
}

/**
 * The server writes a keepalive every 10s (HEARTBEAT_INTERVAL_MS in the client app's sseRoute),
 * so this much silence is a dead connection. Generous on purpose: a busy machine can hold the
 * event loop long enough that bytes already received look late.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

class StreamIdleError extends Error {
  readonly code = 'ESTREAMIDLE';
  constructor(ms: number) {
    super(`no data for ${Math.round(ms / 1000)}s`);
  }
}

const DROP_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESTREAMIDLE']);

/** A transport failure of an open stream, as opposed to anything the server said. */
function isConnectionDrop(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && DROP_CODES.has(code);
}

async function streamOnce(
  axiosInstance: AxiosInstance,
  endpoint: string,
  request: CompletionRequest,
  onEvent: (event: CompletionStreamEvent) => void,
  signal: AbortSignal | undefined,
  options: StreamOptions
): Promise<void> {
  if (signal?.aborted) return;

  let response: AxiosResponse;
  try {
    response = await axiosInstance.post(
      endpoint,
      {
        model: request.model,
        messages: request.messages.map(({ continuesTurn: _continuesTurn, ...message }) => message),
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        // The tool loop on this endpoint belongs to the CALLER: the model emits tool_use and
        // this client executes it locally, then sends the result back as another turn.
        options: {
          stream: true,
          tools: request.tools ?? [],
          ...(request.generation?.temperature !== undefined ? { temperature: request.generation.temperature } : {}),
          ...(request.thinking
            ? {
                thinking: {
                  enabled: true,
                  ...(request.generation?.thinkingBudgetTokens !== undefined
                    ? { budget_tokens: request.generation.thinkingBudgetTokens }
                    : {}),
                },
              }
            : {}),
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          ...(request.cacheTtl ? { cacheTtl: request.cacheTtl } : {}),
        },
      },
      {
        responseType: 'stream',
        signal,
        timeout: COMPLETION_HEADER_TIMEOUT_MS,
        ...(request.loopRunId ? { headers: { [LOOP_RUN_HEADER]: request.loopRunId } } : {}),
      }
    );
  } catch (err) {
    if (signal?.aborted || (isAxiosError(err) && err.code === 'ERR_CANCELED')) return;
    throw toRequestError(err, await readErrorBody(err));
  }

  releaseRequestTimeout(response);
  await readSseStream(response, onEvent, signal, {
    model: request.model,
    sessionId: request.sessionId,
    idleTimeoutMs: options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
  });
}

/**
 * Lift the client's request timeout off the socket once the stream is open.
 *
 * axios hands its `timeout` to follow-redirects, which sets it as the SOCKET's idle timeout with
 * `socket.destroy` as the handler, and clears only its own wall-clock timer when the response
 * arrives. Left alone, any gap that long between bytes of a reply - or an event loop held that
 * long - destroys the socket, and the stream fails with Node's bare "aborted". readSseStream's
 * idle guard bounds the stream instead.
 */
function releaseRequestTimeout(response: AxiosResponse): void {
  const request: unknown = response.request;
  if (!request || typeof request !== 'object' || !('socket' in request)) return;
  const socket: unknown = request.socket;
  if (socket && typeof socket === 'object' && 'setTimeout' in socket && typeof socket.setTimeout === 'function') {
    socket.setTimeout(0);
  }
}

/** What the dev log tags this request's frames with. See logUpstream. */
interface StreamContext {
  model: string;
  sessionId?: string;
  /** See STREAM_IDLE_TIMEOUT_MS. In ms. */
  idleTimeoutMs: number;
}

/**
 * Publish one decoded SSE frame to the developer log.
 *
 * Every field is named explicitly rather than spread off the event: that allowlist, not the
 * sink's scrubbing, is what keeps a credential out of the buffer. The frame's own text IS the
 * line - a stream log that reported only a length could not answer the question it is opened
 * for - and the sink truncates it, scrubs it and flattens it to one line on the way in. The
 * `chars` field carries the true length, which is the only way to tell a short frame from a
 * truncated one.
 */
function logUpstream(event: CompletionStreamEvent, context: StreamContext): void {
  devLog.publish(() => {
    const text = 'text' in event ? (event.text ?? '') : '';
    const detail =
      event.type === 'tool_use'
        ? `${(event.tools ?? []).map(tool => tool.name).join(', ') || '(no tools)'}${text ? ` ${text}` : ''}`
        : event.type === 'error'
          ? (event.message ?? 'no message')
          : text;
    return {
      tags: [CHAT_STREAM_TAG],
      message: `upstream ${event.type}${detail ? `: ${detail}` : ''}`,
      fields: {
        model: context.model,
        ...(text ? { chars: text.length } : {}),
        ...(context.sessionId ? { session: context.sessionId } : {}),
        ...('stopReason' in event && event.stopReason ? { stopReason: event.stopReason } : {}),
        ...('usage' in event && event.usage?.outputTokens !== undefined
          ? { outputTokens: event.usage.outputTokens }
          : {}),
      },
    };
  });
}

function readSseStream(
  response: AxiosResponse,
  onEvent: (event: CompletionStreamEvent) => void,
  signal: AbortSignal | undefined,
  context: StreamContext
): Promise<void> {
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
            if (quiet >= context.idleTimeoutMs) fail(new StreamIdleError(quiet));
            else armIdle(context.idleTimeoutMs - quiet);
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
        logUpstream(event, context);
        if (event.type === 'error') {
          fail(new Error(event.message || 'The server reported an error mid-reply.'));
          return;
        }
        onEvent(event);
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
    const onError = (error: Error) => (signal?.aborted ? finish() : fail(error));
    const onAbort = () => finish();

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    armIdle(context.idleTimeoutMs);
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
 *
 * An expired session never reaches here as a 401: the shared client refreshes and retries it,
 * and one it cannot recover arrives as its own SessionRevokedError, passed through untouched. A
 * 401 that does arrive is one whose body says the credential was accepted, and a 403 is "not
 * allowed", so neither is described as an expiry.
 */
function toRequestError(error: unknown, body?: string): Error {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 403) {
      return new Error(body ? `${body} (status 403)` : 'The server does not allow this request (403).');
    }
    if (status) {
      return new Error(body ? `${body} (status ${status})` : `The completion request failed with status ${status}.`);
    }
    if (error.code === 'ECONNREFUSED') {
      return new Error('Cannot reach the Bike4Mind server. Check the environment and your connection.');
    }
    // Not retried here: the server does not cancel on disconnect, so the abandoned request may
    // still run and bill, and a silent resend could charge the turn twice.
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new Error(
        'The Bike4Mind server took too long to start replying, so this turn stopped. Send your message again to continue.'
      );
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
  if (typeof data === 'string') return messageOf(data.slice(0, ERROR_BODY_LIMIT).trim());
  if (!data || typeof (data as Readable).on !== 'function') return undefined;

  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of data as Readable) {
      chunks.push(Buffer.from(chunk));
      size += chunk.length;
      if (size >= ERROR_BODY_LIMIT) break;
    }
    return messageOf(Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_LIMIT).trim());
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
