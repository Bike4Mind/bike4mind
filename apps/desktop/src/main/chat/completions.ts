import { randomUUID } from 'node:crypto';
import { isAxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import {
  isToolChangeMessage,
  RUN_BUDGET_EXHAUSTED_ERROR_CODE,
  type CompletionRunAttribution,
  type PromptCacheTtl,
  type ReasoningEffort,
} from '@bike4mind/common';
import type { BillingPayer } from '@shared/account';
import type { ChatModelOption, ChatRole } from '@shared/chat';
import type { GenerationSettings } from '@shared/generation';
import { currentBillingPayer, PERSONAL_PAYER } from '../account/billingPayer';
import { devLog } from '../devlog/DevLogSink';
import { ERRORS_TAG } from '../devlog/tags';
import { CHAT_STREAM_TAG } from './devLogTag';
import { parseStreamEvent, type CompletionStreamEvent } from './streamEvents';
import { evaluationContext } from './evaluationBudget';
import { isConnectionDrop, readErrorBody, readSseResponse, releaseRequestTimeout, type ErrorBody } from './sseResponse';

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
  /**
   * On a system prompt: where its per-session tail starts. withCacheBreakpoints sends the two
   * halves as separately cached blocks, so sessions that differ only in the tail (sibling agents
   * in their own worktrees) read the shared half from one cache entry. Never sent.
   */
  cacheSplitAt?: number;
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
  return messages.flatMap((message, index) => {
    if (message.role === 'system' && !isToolChangeMessage(message)) return splitSystem(message);
    return index === rolling || index === lookback ? [{ ...message, cache: true }] : [message];
  });
}

/**
 * A system prompt as one cached block, or two when it names where its per-session tail starts. The
 * tail is left unmarked: the server marks the last system block itself and also marks the last
 * tool, and a marker here would push that one past the provider's limit of four.
 */
function splitSystem({ cacheSplitAt, ...message }: CompletionMessage): CompletionMessage[] {
  const { content } = message;
  if (typeof content !== 'string' || !cacheSplitAt || cacheSplitAt >= content.length) {
    return [{ ...message, cache: true }];
  }
  return [
    { ...message, content: content.slice(0, cacheSplitAt), cache: true },
    { ...message, content: content.slice(cacheSplitAt) },
  ];
}

/** The messages as the server takes them, without the fields this client keeps for itself. */
export function wireMessages<T extends Pick<CompletionMessage, 'continuesTurn' | 'cacheSplitAt'>>(
  messages: readonly T[]
): Omit<T, 'continuesTurn' | 'cacheSplitAt'>[] {
  return messages.map(({ continuesTurn: _continuesTurn, cacheSplitAt: _cacheSplitAt, ...message }) => message);
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
  /**
   * Groups the request's spend under an orchestration run the server issued. Absent outside an
   * orchestrated session. A run the server does not recognise fails the request with
   * RunNotFoundError; see withRunFallback.
   */
  run?: CompletionRunAttribution;
  /** Set when the tools were left out because the model's fixed context cannot hold them: Desktop's prompt plus tools. */
  toolPromptTokens?: number;
  /** Set when the tools were left out because the listed model reports no tool support. */
  toolsUnsupported?: true;
}

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
    const evaluation = evaluationContext.getStore();
    const send = () => streamOnce(axiosInstance, endpoint, request, onEvent, signal, options);
    if (evaluation) await evaluation.serialize(send);
    else await send();
  } catch (err) {
    if (!isConnectionDrop(err)) throw err;
    if (signal?.aborted) return;
    throw new Error(`The connection to the server dropped before the reply finished (${err.message}).`);
  }
}

/** Stream options that bill a run's own payer; none outside a run, so the selection is read. */
export function payerOption(payer: BillingPayer | undefined): StreamOptions {
  return payer ? { billingPayer: () => payer } : {};
}

export interface StreamOptions {
  /** How long the open stream may go without a byte before it is treated as dropped. In ms. */
  idleTimeoutMs?: number;
  /**
   * Read once per HTTP request. Defaults to the payer the user picked in the account menu. A call
   * attached to a run passes the run's payer instead: the server refuses a completion billed to
   * anyone but its run's payer (404 run_not_found), so a mid-run switch must not reach it.
   */
  billingPayer?: () => BillingPayer | Promise<BillingPayer>;
}

/**
 * The server writes a keepalive every 10s (HEARTBEAT_INTERVAL_MS in the client app's sseRoute),
 * so this much silence is a dead connection. Generous on purpose: a busy machine can hold the
 * event loop long enough that bytes already received look late.
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

async function streamOnce(
  axiosInstance: AxiosInstance,
  endpoint: string,
  request: CompletionRequest,
  onEvent: (event: CompletionStreamEvent) => void,
  signal: AbortSignal | undefined,
  options: StreamOptions
): Promise<void> {
  if (signal?.aborted) return;

  // Fresh per HTTP request, never reused: the server keys the request's ledger charge on it,
  // so a resend under the same id would read as the same charge.
  const context: StreamContext = {
    model: request.model,
    sessionId: request.sessionId,
    idleTimeoutMs: options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    requestId: randomUUID(),
  };
  const requestId = context.requestId;
  const evaluation = evaluationContext.getStore();
  evaluation?.assertTransportOpen();
  await evaluation?.reconcile();
  const events: CompletionStreamEvent[] = [];
  const release = evaluation?.reserve(requestId, request, evaluationModel(axiosInstance, request.model));
  let failed = true;
  try {
    const evaluationWire = evaluation?.wire(requestId);
    evaluation?.measure(requestId, request);
    // An evaluation run is minted without a payer, so it is Personal and its completions must be too.
    const { organization_id: organizationId } = evaluationWire
      ? PERSONAL_PAYER
      : await (options.billingPayer ?? currentBillingPayer)();
    let response: AxiosResponse;
    try {
      response = await axiosInstance.post(
        endpoint,
        {
          model: request.model,
          // Omitted for Personal: the route already bills the caller there, and an older server ignores it.
          ...(organizationId ? { organization_id: organizationId } : {}),
          messages: wireMessages(request.messages),
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(request.run ? { run: request.run } : {}),
          ...(evaluationWire
            ? {
                evaluation: evaluationWire.evaluation,
                run: {
                  ...request.run,
                  ...evaluationWire.run,
                  role: request.run?.role ?? 'root',
                  purpose: request.run?.purpose ?? 'turn',
                },
              }
            : {}),
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
          headers: { 'X-Request-ID': requestId },
        }
      );
    } catch (err) {
      if (signal?.aborted || (isAxiosError(err) && err.code === 'ERR_CANCELED')) return;
      const body = await readErrorBody(err);
      if (isRunNotFound(err, body)) throw new RunNotFoundError(body?.message);
      if (isRunBudgetExhausted(err, body)) throw new RunBudgetExhaustedError(body?.message);
      const failure = toRequestError(err, body?.message);
      logError(failure, 'request', context, {
        ...(isAxiosError(err) && err.response?.status ? { status: err.response.status } : {}),
        ...(isAxiosError(err) && !err.response?.status && err.code ? { code: err.code } : {}),
        ...(body?.errorCode ? { errorCode: body.errorCode } : {}),
      });
      throw failure;
    }

    releaseRequestTimeout(response);
    await readSseStream(
      response,
      event => {
        if (evaluation) {
          if (event.type === 'meta' || event.type === 'settled') events.push(event);
          else if ('usage' in event && event.usage) events.push({ type: 'content', usage: event.usage });
        }
        onEvent(event);
      },
      signal,
      context
    );
    failed = signal?.aborted ?? false;
  } finally {
    try {
      evaluation?.record(requestId, events, failed);
      await evaluation?.reconcile();
    } finally {
      release?.();
    }
  }
}

const evaluationModels = new WeakMap<AxiosInstance, Map<string, ChatModelOption>>();

export function bindEvaluationModel(axios: AxiosInstance, model: ChatModelOption): void {
  const models = evaluationModels.get(axios) ?? new Map<string, ChatModelOption>();
  models.set(model.id, model);
  evaluationModels.set(axios, models);
}

function evaluationModel(axios: AxiosInstance, id: string): ChatModelOption {
  return evaluationModels.get(axios)?.get(id) ?? { id, name: id };
}

/** What the dev log tags this request's frames with. See logUpstream. */
interface StreamContext {
  model: string;
  sessionId?: string;
  /** See STREAM_IDLE_TIMEOUT_MS. In ms. */
  idleTimeoutMs: number;
  /** The X-Request-ID sent with the POST; the key the server's own logs use. */
  requestId: string;
}

/**
 * Publish one failure to the developer log, retained even with the window closed.
 *
 * `message` is the text the user sees (never a response body: readErrorBody already reduced that
 * to `message` and `errorCode`). `extra` is named by the caller, never spread from a response.
 */
function logError(
  error: Error,
  source: 'request' | 'stream' | 'transport',
  context: StreamContext,
  extra: Readonly<Record<string, string | number>> = {}
): void {
  devLog.publishError(() => ({
    tags: [CHAT_STREAM_TAG, ERRORS_TAG],
    message: error.message,
    fields: {
      source,
      operation: 'completion',
      ...extra,
      requestId: context.requestId,
      model: context.model,
      ...(context.sessionId ? { session: context.sessionId } : {}),
    },
  }));
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
  // A provider failure delivered inside a 200 stream: kept even with the window closed.
  const publish = event.type === 'error' ? devLog.publishError.bind(devLog) : devLog.publish.bind(devLog);
  publish(() => {
    const text = 'text' in event ? (event.text ?? '') : '';
    const detail =
      event.type === 'tool_use'
        ? `${(event.tools ?? []).map(tool => tool.name).join(', ') || '(no tools)'}${text ? ` ${text}` : ''}`
        : event.type === 'error'
          ? (event.message ?? 'no message')
          : text;
    return {
      tags: event.type === 'error' ? [CHAT_STREAM_TAG, ERRORS_TAG] : [CHAT_STREAM_TAG],
      message: `upstream ${event.type}${detail ? `: ${detail}` : ''}`,
      fields: {
        model: context.model,
        requestId: context.requestId,
        ...(event.type === 'error' ? { source: 'stream', operation: 'completion' } : {}),
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
  return readSseResponse(response, {
    signal,
    idleTimeoutMs: context.idleTimeoutMs,
    onTransportError: error => logError(error, 'transport', context),
    onData: data => {
      if (data === '[DONE]') return 'done';
      let decoded: unknown;
      try {
        decoded = JSON.parse(data);
      } catch {
        // A malformed frame is skipped rather than fatal: the rest of the reply is still good.
        return;
      }
      const event = parseStreamEvent(decoded);
      if (!event) return;
      logUpstream(event, context);
      if (event.type === 'error') return new Error(event.message || 'The server reported an error mid-reply.');
      onEvent(event);
    },
  });
}

/** The server did not recognise the request's `run`: deleted, or issued to another account. */
export class RunNotFoundError extends Error {
  readonly errorCode = 'run_not_found';
  constructor(message?: string) {
    super(message || 'The server does not recognise this orchestration run.');
    this.name = 'RunNotFoundError';
  }
}

export function isRunNotFound(error: unknown, body: ErrorBody | undefined): boolean {
  return isAxiosError(error) && error.response?.status === 404 && body?.errorCode === 'run_not_found';
}

/**
 * The request's `run` has no budget left (422 run_budget_exhausted). Refused before the provider
 * was called, so nothing was charged; the run resumes once its budget is raised.
 */
export class RunBudgetExhaustedError extends Error {
  readonly errorCode = RUN_BUDGET_EXHAUSTED_ERROR_CODE;
  constructor(message?: string) {
    super(message || 'This orchestration run has used its credit budget.');
    this.name = 'RunBudgetExhaustedError';
  }
}

export function isRunBudgetExhausted(error: unknown, body: ErrorBody | undefined): boolean {
  return isAxiosError(error) && error.response?.status === 422 && body?.errorCode === RUN_BUDGET_EXHAUSTED_ERROR_CODE;
}

/**
 * Send `request` with `run`, and once more without it if the server refuses the run, so a stale
 * or foreign run id costs the turn nothing. `onRejected` runs before the resend, to forget the id.
 * Safe to resend: a refused run fails before the provider is called, so nothing was billed.
 *
 * A `budgeted` run is never resent without `run`: that would spend outside the cap the user set.
 * Its refusal still runs `onRejected` and then rethrows.
 */
export async function withRunFallback<T>(
  run: CompletionRunAttribution | undefined,
  send: (run: CompletionRunAttribution | undefined) => Promise<T>,
  onRejected: (error: RunNotFoundError) => void | Promise<void>,
  options: { budgeted?: boolean } = {}
): Promise<T> {
  try {
    return await send(run);
  } catch (err) {
    if (!run || !(err instanceof RunNotFoundError)) throw err;
    await onRejected(err);
    if (options.budgeted) throw err;
    return send(undefined);
  }
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
