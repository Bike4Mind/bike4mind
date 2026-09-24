/**
 * Server-Sent Events (SSE) utilities for CLI LLM completions
 * Shared between Next.js API route and Lambda function
 */
import type { QuestErrorCode } from '../types/entities/SessionTypes';
import type { StreamChannel } from './streamVisibility';

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
  /**
   * Set when this chunk is NOT the assistant's prose reply - reasoning, or a raw tool
   * artifact. Public surfaces drop the text of such a frame; first-party surfaces ignore
   * the field and keep receiving it. See {@link StreamChannel}.
   */
  channel?: StreamChannel;
}

/**
 * Build SSE event from LLM completion callback
 * @param text - Sparse array indexed by the provider's content-block/choice index (may
 *   contain null/undefined/holes). NOT [thinking, response] - see
 *   {@link resolveResponseText} for the real shape. This positional read is kept for
 *   first-party surfaces that already depend on it; public callers use
 *   {@link buildPublicSSEEvent}, which resolves the whole array.
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
 * [thinking, response]. Every streaming backend declares its `streamedText` INSIDE the
 * `for await` over provider events (anthropic, openai, gemini, kimi, deepseek, xai,
 * bedrock), so one callback populates exactly the index the provider used - 2 or higher as
 * soon as two blocks precede the text, which a fixed [1]/[0] read drops entirely. The lone
 * dense shape is the non-streaming anthropic path, which pushes one entry per response text
 * block.
 *
 * Rule: join every populated entry in index order. It drops nothing at any index, and it
 * cannot merge channels - reasoning arrives on its own callback, tagged (see
 * CompletionInfo.channel), and is never pushed at all in the non-streaming path (thinking
 * blocks carry `.thinking`, not `.text`).
 */
function resolveResponseText(text: (string | null | undefined)[]): string {
  let out = '';
  for (const entry of text) {
    if (entry) out += entry;
  }
  return out;
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
 * It does NOT filter the text. Keeping reasoning out of a public stream is the CALLER's
 * job, done by admitting only models whose reasoning cannot reach the text channel - see
 * {@link inlinesReasoningIntoText}. Scanning the text for `<think>` here would be worse
 * than useless: on an admitted family that token is ordinary prose (ask any model to
 * explain the tag), so treating it as a marker truncates a legitimate paid reply, while an
 * unadmitted family cannot be made safe by parsing anyway, because the reasoning between
 * the markers is model-generated and may contain them. A new public caller must run the
 * same family gate before it streams.
 */
export function buildPublicSSEEvent(text: (string | null | undefined)[], info?: CompletionInfo): SSEContentEvent {
  // A tagged frame is reasoning or a raw tool artifact, never the reply. Its usage still
  // counts, so the frame is kept and only its text is dropped. Structural, not a content
  // scan: the adapter marked it at the emit site, where the two were still distinguishable.
  const responseOnly: (string | null | undefined)[] = ['', info?.channel ? '' : resolveResponseText(text)];
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
