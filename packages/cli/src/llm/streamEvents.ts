import { z } from 'zod';

/**
 * Unified streaming event protocol for CLI LLM backends.
 *
 * Both transports - `ServerLlmBackend` (SSE) and `WebSocketLlmBackend`
 * (HTTP POST + WebSocket frames) - decode their wire payloads into this single
 * typed union, then feed it to `StreamAccumulator`. This collapses the two
 * previously-duplicated, loosely-typed chunk shapes (`SSEEvent` in
 * ServerLlmBackend, the inline `chunk` type in WebSocketLlmBackend) into one
 * source of truth, and replaces the unchecked `as SSEEvent` cast on
 * server-provided data with a runtime-validated parse at the boundary.
 *
 * The vocabulary mirrors what the backends emit today (`content` / `tool_use` /
 * `error`) so the refactor changes no observable behavior. Finer-grained delta
 * events (text_delta / toolcall_delta / ...) are intentionally out of scope - the
 * CLI accumulates a full turn before firing its callback, so per-delta events
 * would be a behavior change, not a refactor.
 */

/**
 * Token usage counts carried alongside content/tool_use events. Shape mirrors
 * `SSEContentEvent.usage` in `@bike4mind/common` (`sseEvents.ts`) - the
 * authoritative wire contract - including the Anthropic cache-token deltas
 * so they survive the boundary parse instead of being stripped.
 */
export const usageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
  })
  .partial();
export type Usage = z.infer<typeof usageSchema>;

/** Credit/cost accounting carried alongside content/tool_use events (SSE only). */
export const creditsSchema = z
  .object({
    used: z.number().optional(),
    usdCost: z.number().optional(),
  })
  .partial();
export type Credits = z.infer<typeof creditsSchema>;

/**
 * A single tool call requested by the model. Shape mirrors the wire contract in
 * `@bike4mind/common` (`SSEContentEvent.tools` / `CompletionInfo.toolsUsed`):
 * the server sends `{ name, arguments?: string, id? }` - `arguments` is a raw
 * JSON string, NOT a parsed object. (The previous `input: Record<...>` shape was
 * a typed lie the old unchecked `as SSEEvent` cast hid; downstream consumers
 * read `tool.arguments`, e.g. `toolParallelizer.ts`.)
 */
export const toolUseSchema = z.object({
  name: z.string(),
  arguments: z.string().optional(),
  id: z.string().optional(),
});
export type ToolUse = z.infer<typeof toolUseSchema>;

/**
 * Discriminated union of streaming events. `thinking` blocks are opaque
 * provider-shaped objects (Anthropic extended thinking) replayed verbatim into
 * the next request, so they stay `unknown[]` rather than being modeled.
 */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('content'),
    text: z.string().optional(),
    usage: usageSchema.optional(),
    credits: creditsSchema.optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    text: z.string().optional(),
    tools: z.array(toolUseSchema).optional(),
    thinking: z.array(z.unknown()).optional(),
    usage: usageSchema.optional(),
    credits: creditsSchema.optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().optional(),
  }),
]);
export type StreamEvent = z.infer<typeof streamEventSchema>;

/**
 * Validate an already-JSON-decoded wire payload against the event union.
 *
 * Returns the typed event on success, or `null` when the payload does not match
 * a known event shape. A `null` result is treated as "skip this event" by the
 * backends - preserving the prior behavior where an unrecognized `type` simply
 * fell through unhandled. (Malformed JSON is still caught upstream at the
 * `JSON.parse` boundary.)
 */
export function parseStreamEvent(data: unknown): StreamEvent | null {
  const result = streamEventSchema.safeParse(data);
  return result.success ? result.data : null;
}
