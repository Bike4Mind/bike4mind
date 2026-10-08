import { z } from 'zod';
import type { ChatUsage } from '@shared/chat';

/**
 * The wire events `POST /api/ai/v1/completions` emits over SSE.
 *
 * MUST stay in sync with `CompletionStreamEventSchema` in @bike4mind/common
 * (`schemas/cliCompletions.ts`), the authoritative contract, and with the CLI's own copy in
 * `packages/cli/src/llm/streamEvents.ts`. Restated here rather than imported because the
 * common barrel is not importable from Electron main without dragging in its Node-only
 * dependencies, and the CLI is not a dependency of this app.
 *
 * Unknown keys are stripped by these schemas, so a field absent here is dropped no matter
 * what the server sends - `stopReason` in particular has to be declared to survive.
 */

const usageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    cacheCreationInputTokens: z.number().optional(),
  })
  .partial();

// Sent beside `usage`, not inside it - see buildSSEEvent.
const creditsSchema = z.object({
  used: z.number().optional(),
  usdCost: z.number().optional(),
});

const toolUseSchema = z.object({
  name: z.string(),
  arguments: z.string().optional(),
  id: z.string().optional(),
});

// A tool call the model has begun writing, ahead of the finished call. See toolStarted in
// CompletionInfo (@bike4mind/common).
const toolStartedSchema = z.object({ name: z.string(), id: z.string().optional() });

export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('content'),
    text: z.string().optional(),
    usage: usageSchema.optional(),
    credits: creditsSchema.optional(),
    stopReason: z.string().optional(),
    toolStarted: toolStartedSchema.optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    text: z.string().optional(),
    tools: z.array(toolUseSchema).optional(),
    // Opaque provider reasoning blocks (Anthropic extended thinking). They must be replayed
    // verbatim alongside the tool_use they accompany, or the next turn is rejected.
    thinking: z.array(z.unknown()).optional(),
    usage: usageSchema.optional(),
    credits: creditsSchema.optional(),
    stopReason: z.string().optional(),
    toolStarted: toolStartedSchema.optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string().optional(),
  }),
  // Opens the stream and carries the server's request id; nothing downstream needs it yet,
  // but parsing it keeps it out of the "unrecognized event" path.
  z.object({
    type: z.literal('meta'),
    requestId: z.string().optional(),
  }),
]);

export type CompletionStreamEvent = z.infer<typeof streamEventSchema>;

/**
 * Validate an already-JSON-decoded payload. `null` means "not a shape we know" and is
 * treated as skip-this-event rather than an error, so a new server event type reaches an
 * older build as silence instead of a failed turn.
 */
export function parseStreamEvent(data: unknown): CompletionStreamEvent | null {
  const result = streamEventSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Fold one frame's usage and credits into what the request has reported so far. Counts within a
 * request are cumulative, so a later value replaces an earlier one; a frame that omits a field
 * (credits often ride a different frame from the tokens) leaves it alone.
 */
export function foldUsage(current: ChatUsage | undefined, event: CompletionStreamEvent): ChatUsage | undefined {
  if (event.type !== 'content' && event.type !== 'tool_use') return current;
  const { usage, credits } = event;
  if (!usage && !credits) return current;
  const next: ChatUsage = { ...current };
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (value !== undefined) next[key as keyof ChatUsage] = value;
  }
  if (credits?.used !== undefined) next.creditsUsed = credits.used;
  if (credits?.usdCost !== undefined) next.usdCost = credits.usdCost;
  return next;
}

/**
 * Add one round trip's reported usage to the turn's running total.
 *
 * Absent stays absent: a server that reported nothing must not be made to look like it reported
 * zero, because the status line draws the field only once there is a real number behind it.
 */
export function addUsage(total: ChatUsage | undefined, next: ChatUsage | undefined): ChatUsage | undefined {
  if (!next) return total;
  if (!total) return next;
  const sum: ChatUsage = {};
  for (const key of USAGE_FIELDS) {
    if (total[key] !== undefined || next[key] !== undefined) sum[key] = (total[key] ?? 0) + (next[key] ?? 0);
  }
  return sum;
}

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'creditsUsed',
  'usdCost',
] as const satisfies readonly (keyof ChatUsage)[];
