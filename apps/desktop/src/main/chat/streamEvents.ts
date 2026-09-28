import { z } from 'zod';

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
  })
  .partial();

const toolUseSchema = z.object({
  name: z.string(),
  arguments: z.string().optional(),
  id: z.string().optional(),
});

export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('content'),
    text: z.string().optional(),
    usage: usageSchema.optional(),
    stopReason: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_use'),
    text: z.string().optional(),
    tools: z.array(toolUseSchema).optional(),
    usage: usageSchema.optional(),
    stopReason: z.string().optional(),
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
