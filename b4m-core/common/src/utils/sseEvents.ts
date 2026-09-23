/**
 * Server-Sent Events (SSE) utilities for CLI LLM completions
 * Shared between Next.js API route and Lambda function
 */
import type { QuestErrorCode } from '../types/entities/SessionTypes';
import { THINK_OPEN_TAG } from './streamVisibility';

export interface SSEContentEvent {
  type: 'content' | 'tool_use';
  text: string;
  tools?: Array<{
    name: string;
    arguments?: string;
    id?: string;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /** Anthropic-style cache token deltas */
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  /**
   * Credit usage information for real-time display
   */
  credits?: {
    used?: number; // Credits used for this completion so far
    usdCost?: number; // USD cost for this completion
  };
  /**
   * The complete assistant message content including thinking blocks.
   * Required for Anthropic extended thinking when tools are used.
   */
  thinking?: unknown[];
  /**
   * How the backend honored the request's `response_format`. Mirrors the
   * `X-B4M-Response-Format-Mode` HTTP header semantics for the SSE channel.
   */
  responseFormatMode?: 'native' | 'tool_use' | 'best-effort';
  /**
   * Why generation stopped, on the terminal event of a stream. Normalized to the
   * `CompletionInfo.stopReason` vocabulary (see llm-adapters/stopReason.ts), so
   * 'max_tokens' means the reply was CUT OFF rather than finished. Without this on the
   * wire a truncated answer is indistinguishable from a complete one, which is exactly
   * how a starved output budget stayed invisible to CLI users. Absent on interim
   * chunks and whenever the provider reports nothing.
   */
  stopReason?: string;
}

export interface SSEErrorEvent {
  type: 'error';
  message: string;
  /** Correlation ID for this request, when available. */
  requestId?: string;
  /**
   * Machine-readable classifier (see QUEST_ERROR_CODES), when the failure is a
   * recognized billing/policy condition. Absent for unclassified errors - clients
   * must treat it as optional.
   */
  code?: QuestErrorCode;
}

/**
 * Meta event - carries the request's correlation ID. Emitted as the first
 * non-keepalive event on a stream so callers can correlate a failure with
 * server logs.
 */
export interface SSEMetaEvent {
  type: 'meta';
  requestId: string;
}

export type SSEEvent = SSEContentEvent | SSEErrorEvent | SSEMetaEvent;

export interface CompletionInfo {
  toolsUsed?: Array<{
    name: string;
    arguments?: string;
    id?: string;
  }>;
  inputTokens?: number;
  outputTokens?: number;
  /** Anthropic-style cache token deltas */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * Credit usage information
   */
  creditsUsed?: number;
  usdCost?: number;
  /**
   * The complete assistant message content including thinking blocks.
   * Required for Anthropic extended thinking when tools are used.
   */
  thinking?: unknown[];
  /**
   * How the backend honored response_format ('native' | 'tool_use' | 'best-effort').
   */
  responseFormatMode?: 'native' | 'tool_use' | 'best-effort';
  /**
   * Why generation stopped, in the vocabulary normalized by llm-adapters/stopReason.ts.
   * Mirrored onto SSEContentEvent.stopReason by buildSSEEvent.
   */
  stopReason?: string;
}

/**
 * Build SSE event from LLM completion callback
 * @param text - Sparse array indexed by the provider's content-block/choice index (may
 *   contain null/undefined/holes). NOT [thinking, response] - see
 *   {@link resolveResponseText} for the real shape. This positional read is kept for
 *   first-party surfaces that already depend on it; public callers use
 *   {@link createPublicSSEEventBuilder}, which resolves the whole array.
 * @param info - Completion metadata (tools, usage)
 * @returns SSE event object
 */
export function buildSSEEvent(text: (string | null | undefined)[], info?: CompletionInfo): SSEContentEvent {
  const textContent = text[1] || text[0] || '';

  const event: SSEContentEvent = {
    type: info?.toolsUsed && info.toolsUsed.length > 0 ? 'tool_use' : 'content',
    text: textContent,
  };

  if (info?.toolsUsed && info.toolsUsed.length > 0) {
    // Project rather than pass the array through by reference: toolsUsed is re-emitted on
    // every streaming callback (not just the terminal one), and once a backend attaches a
    // returnValue (up to several KB, see recordToolResult) that reference would put the full
    // tool output on every SSE frame. SSEContentEvent.tools is the declared wire contract and
    // stays narrow regardless of what CompletionInfo.toolsUsed later grows.
    event.tools = info.toolsUsed.map(t => ({ name: t.name, arguments: t.arguments, id: t.id }));
  }

  if (
    info?.inputTokens !== undefined ||
    info?.outputTokens !== undefined ||
    info?.cacheReadInputTokens !== undefined ||
    info?.cacheCreationInputTokens !== undefined
  ) {
    event.usage = {
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      cacheReadInputTokens: info.cacheReadInputTokens,
      cacheCreationInputTokens: info.cacheCreationInputTokens,
    };
  }

  if (info?.creditsUsed !== undefined || info?.usdCost !== undefined) {
    event.credits = {
      used: info.creditsUsed,
      usdCost: info.usdCost,
    };
  }

  if (info?.thinking && info.thinking.length > 0) {
    event.thinking = info.thinking;
  }

  if (info?.responseFormatMode) {
    event.responseFormatMode = info.responseFormatMode;
  }

  if (info?.stopReason) {
    event.stopReason = info.stopReason;
  }

  return event;
}

/**
 * Resolve the response text carried by ONE adapter callback.
 *
 * `text` is a SPARSE array indexed by the provider's content-block/choice index - never
 * [thinking, response]. Every streaming backend allocates it fresh inside its event loop
 * (anthropicBackend.ts:1330, kimiBackend.ts:506, deepseekBackend.ts:451, xaiBackend.ts:582,
 * openaiBackend.ts:1476, geminiBackend.ts:669), so one callback populates exactly the index
 * the provider used - 2 or higher as soon as two blocks precede the text, which a fixed
 * [1]/[0] read drops entirely. The lone dense shape is the non-streaming anthropic path,
 * which pushes one entry per response text block (anthropicBackend.ts:1999).
 *
 * Rule: join every populated entry in index order. It drops nothing at any index, and it
 * cannot merge channels - reasoning arrives on its own callback when streaming, and is
 * never pushed at all in the non-streaming path (thinking blocks carry `.thinking`, not
 * `.text`).
 */
function resolveResponseText(text: (string | null | undefined)[]): string {
  let out = '';
  for (const entry of text) {
    if (entry) out += entry;
  }
  return out;
}

/**
 * Longest suffix of `text` that is a proper prefix of THINK_OPEN_TAG - a marker the
 * provider split across streaming chunks. Held back rather than forwarded, so a
 * half-arrived `<thi` can never reach a public caller as prose.
 */
function danglingTagPrefix(text: string): string {
  const tag = THINK_OPEN_TAG;
  for (let len = Math.min(text.length, tag.length - 1); len > 0; len--) {
    if (tag.startsWith(text.slice(text.length - len))) return text.slice(text.length - len);
  }
  return '';
}

/**
 * Reasoning guard for ONE public stream: everything from the first THINK_OPEN_TAG onward
 * is dropped, to the end of the stream.
 *
 * It deliberately does NOT look for THINK_CLOSE_TAG and resume. The text between the
 * markers is model-generated and unescaped, so reasoning containing the close marker would
 * end redaction early and put the rest of the monologue on an anonymous stream - the
 * markers cannot be parsed as a trust boundary. What they CAN do is announce that reasoning
 * has started, which is enough to fail closed. Models whose reasoning legitimately streams
 * this way are refused before the stream opens ({@link inlinesReasoningIntoText}), so on a
 * correctly gated route this suppression is an anomaly path, not the normal one - and the
 * builder reports it via `redactedReasoning` so the operator can tell it from an empty reply.
 *
 * Stateful by necessity: backends emit per-chunk deltas (each allocates `streamedText`
 * inside its own event loop), so a marker can straddle two callbacks.
 */
function createReasoningStripper(): {
  strip: (chunk: string) => string;
  flush: () => string;
  isSuppressing: () => boolean;
} {
  let suppressing = false;
  let held = '';
  const strip = (chunk: string) => {
    if (suppressing) return '';
    const rest = held + chunk;
    held = '';
    const open = rest.indexOf(THINK_OPEN_TAG);
    if (open !== -1) {
      suppressing = true;
      return rest.slice(0, open);
    }
    held = danglingTagPrefix(rest);
    return rest.slice(0, rest.length - held.length);
  };
  // A held marker prefix that no further chunk completed was never a marker - release it as
  // the prose it is, or an answer ending in `<` or `<thi` is truncated. Nothing is released
  // once suppressing: past the open marker everything is reasoning.
  const flush = () => {
    const tail = suppressing ? '' : held;
    held = '';
    return tail;
  };
  return { strip, flush, isSuppressing: () => suppressing };
}

/**
 * Build an SSE event for an ANONYMOUS/public caller (e.g. the embed chat widget).
 * Allowlists only what such a caller may see - assistant text plus usage/credit
 * accounting - and drops server-internal reasoning metadata: tool calls
 * (`toolsUsed` names + model-chosen arguments), extended-thinking blocks
 * (`thinking`), and `responseFormatMode`. It also withholds `usdCost` (raw
 * provider dollar cost): an anonymous widget visitor is not the account
 * holder, so the owner's model economics stay private; `creditsUsed` is the
 * only consumption signal forwarded. This is a redaction contract, so it
 * allowlists forward: any field later added to CompletionInfo stays hidden from
 * public surfaces until deliberately surfaced here.
 *
 * Reasoning is stripped from the text itself too - see {@link createReasoningStripper}
 * - which is why this is a stateful builder rather than a pure function. A streaming
 * caller MUST call `flush` once the completion is done and write any event it returns
 * before [DONE]: the guard holds back a trailing partial marker, and only the end
 * of the stream proves that text was prose rather than the start of a `<think>`.
 */
export function createPublicSSEEventBuilder(): {
  build: (text: (string | null | undefined)[], info?: CompletionInfo) => SSEContentEvent;
  flush: () => SSEContentEvent | null;
  /**
   * True once reasoning appeared and the remainder was REDACTED rather than never sent.
   * On a correctly gated route this should never fire; an empty public reply otherwise
   * looks identical to a backend that returned nothing.
   */
  redactedReasoning: () => boolean;
} {
  const reasoning = createReasoningStripper();
  const build = (text: (string | null | undefined)[], info?: CompletionInfo): SSEContentEvent => {
    // Resolve over the WHOLE sparse array - see resolveResponseText. Reading a fixed
    // [1]/[0] dropped the text of every ordinary reply (index 0) and still dropped any
    // block the provider placed at index 2 or beyond. Reasoning is redacted by the
    // <think> sentinels below, never by position.
    const responseOnly: (string | null | undefined)[] = ['', reasoning.strip(resolveResponseText(text))];
    if (!info) return buildSSEEvent(responseOnly, undefined);
    // Allowlist forward (not denylist): explicitly name the fields a public caller may
    // see, so a field later added to CompletionInfo stays hidden until surfaced HERE.
    // Everything not listed (toolsUsed, thinking, responseFormatMode, usdCost, and
    // any future addition) is dropped by omission.
    const safeInfo: CompletionInfo = {
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      cacheReadInputTokens: info.cacheReadInputTokens,
      cacheCreationInputTokens: info.cacheCreationInputTokens,
      creditsUsed: info.creditsUsed,
    };
    return buildSSEEvent(responseOnly, safeInfo);
  };
  const flush = () => {
    const tail = reasoning.flush();
    return tail ? buildSSEEvent(['', tail]) : null;
  };
  return { build, flush, redactedReasoning: reasoning.isSuppressing };
}

/**
 * Single-shot {@link createPublicSSEEventBuilder}, for a one-chunk (non-streaming)
 * public event. A STREAM must use the builder instead: reasoning sentinels span
 * chunks, and a fresh stripper per chunk cannot pair them.
 */
export function buildPublicSSEEvent(text: (string | null | undefined)[], info?: CompletionInfo): SSEContentEvent {
  const builder = createPublicSSEEventBuilder();
  const event = builder.build(text, info);
  // No chunk can follow, so a held tag prefix is prose. Fold it into this event rather
  // than return a second one a single-shot caller has nowhere to put.
  const tail = builder.flush();
  if (tail) event.text += tail.text;
  return event;
}

/**
 * Format error as SSE event
 * @param error - Error object or message
 * @param requestId - Correlation ID to attach, when available
 * @param code - Machine-readable classifier to attach, when the caller resolved one
 * @returns SSE error event
 */
export function formatSSEError(error: unknown, requestId?: string, code?: QuestErrorCode): SSEErrorEvent {
  const message = error instanceof Error ? error.message : 'Internal server error';
  return {
    type: 'error',
    message,
    ...(requestId && { requestId }),
    ...(code && { code }),
  };
}

/**
 * Build the SSE meta event carrying the request's correlation ID.
 * Emit as the first non-keepalive event on a stream.
 * @param requestId - The request's correlation ID
 * @returns SSE meta event
 */
export function buildMetaEvent(requestId: string): SSEMetaEvent {
  return { type: 'meta', requestId };
}

/**
 * Serialize SSE event to data string
 * @param event - SSE event object
 * @returns Formatted SSE data string (e.g., "data: {...}\n\n")
 */
export function serializeSSEEvent(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * SSE [DONE] signal
 */
export const SSE_DONE_SIGNAL = 'data: [DONE]\n\n';

/**
 * SSE keep-alive comment.
 *
 * Per the WHATWG SSE spec (§9.2), any line starting with `:` is a comment and is
 * completely ignored by the EventSource parser - no event is dispatched, no client-side
 * handling is required.
 *
 * Send periodically (every ~25s) to beat CloudFront's default 30s origin response timeout.
 * Without this, CloudFront returns a 504 if no bytes arrive within its idle window.
 */
export const SSE_KEEPALIVE = ': keep-alive\n\n';
