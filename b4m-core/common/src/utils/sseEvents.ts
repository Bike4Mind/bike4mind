/**
 * Server-Sent Events (SSE) utilities for CLI LLM completions
 * Shared between Next.js API route and Lambda function
 */
import type { QuestErrorCode } from '../types/entities/SessionTypes';

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
}

/**
 * Build SSE event from LLM completion callback
 * @param text - Array of text chunks [thinking, response] (may contain null/undefined)
 * @param info - Completion metadata (tools, usage)
 * @returns SSE event object
 */
export function buildSSEEvent(text: (string | null | undefined)[], info?: CompletionInfo): SSEContentEvent {
  // Get text content (text[0] = thinking, text[1] = response)
  const textContent = text[1] || text[0] || '';

  const event: SSEContentEvent = {
    type: info?.toolsUsed && info.toolsUsed.length > 0 ? 'tool_use' : 'content',
    text: textContent,
  };

  if (info?.toolsUsed && info.toolsUsed.length > 0) {
    event.tools = info.toolsUsed;
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

  return event;
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
 */
export function buildPublicSSEEvent(text: (string | null | undefined)[], info?: CompletionInfo): SSEContentEvent {
  // text[0] is the thinking channel, text[1] the response. Pass ONLY the response
  // (never fall back to text[0]) so no reasoning content rides along. buildSSEEvent
  // reads index [1], so put the response there with an empty thinking slot.
  const responseOnly: (string | null | undefined)[] = ['', text[1] ?? ''];
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
