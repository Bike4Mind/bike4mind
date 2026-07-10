import { z } from 'zod';

/**
 * Tool schema matching ICompletionOptionTools.toolSchema. The Zod surface only
 * covers wire-format fields (toolFn is server-side). Replaces the historical
 * z.array(z.any()) so client-side bugs (typos in name, missing type) surface
 * at parse time instead of failing silently inside the backend.
 */
export const CompletionToolSchema = z.object({
  toolSchema: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z
      .object({
        type: z.literal('object'),
        properties: z.record(z.string(), z.any()).optional(),
        additionalProperties: z.boolean().optional(),
        required: z.array(z.string()).optional(),
      })
      .passthrough(),
    strict: z.boolean().optional(),
  }),
  _isMcpTool: z.boolean().optional(),
});

export type CompletionTool = z.infer<typeof CompletionToolSchema>;

/**
 * JSON Schema definition for structured output. The `schema` field is a full
 * JSON Schema document (we don't try to validate JSON Schema with Zod - that's
 * the caller's contract with the model). `strict: true` is the default, matching
 * OpenAI's strict-mode subset semantics.
 */
export const ResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      description: z.string().optional(),
      schema: z.record(z.string(), z.any()),
      strict: z.boolean().optional().default(true),
    }),
  }),
]);

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

/**
 * Wire-format message for /api/ai/v1/completions. The optional `cache: true`
 * flag is honored by Anthropic (translated to `cache_control: { type: 'ephemeral' }`
 * with the appropriate beta header) and silently ignored by other providers.
 */
export const CompletionMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string(), z.array(z.any())]),
  cache: z.boolean().optional(),
});

export type CompletionMessage = z.infer<typeof CompletionMessageSchema>;

/**
 * Schema for CLI LLM completion requests
 * Shared between Next.js API route (dev) and Lambda function (production)
 *
 * `response_format`, `stream`, `tools`, `temperature`, and `max_tokens` are all
 * accepted at the top level (OpenAI-compatible, matching how every major LLM
 * SDK shapes a completion request) AND nested under `options` (legacy shape).
 * Use `normalizeCompletionRequest()` to collapse both surfaces into the
 * canonical `options.<field>` location before downstream consumption.
 */
export const CompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(CompletionMessageSchema),
  response_format: ResponseFormatSchema.optional(),
  stream: z.boolean().optional(),
  tools: z.array(CompletionToolSchema).optional(),
  temperature: z.number().optional(),
  // OpenAI wire naming; normalizes into options.maxTokens alongside the legacy `maxTokens` alias.
  max_tokens: z.number().optional(),
  options: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
      stream: z.boolean().optional(),
      tools: z.array(CompletionToolSchema).optional(),
      response_format: ResponseFormatSchema.optional(),
    })
    .optional(),
});

export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;

/**
 * Hoist top-level OpenAI-shape fields (`response_format`, `stream`, `tools`,
 * `temperature`, `max_tokens`) into their `options.<field>` equivalents so all
 * downstream code reads from a single canonical location. If both surfaces are
 * present for a field, the top-level value wins (matches OpenAI's spec, where
 * the top-level field is the official location). Idempotent.
 *
 * Destructuring (rather than a hand-written list of fields to delete) means a
 * field that was never sent stays absent from the result instead of becoming
 * an explicit `undefined` own-property - keeping the normalized shape
 * indistinguishable from what Zod would produce for a request that never had
 * these fields at the top level.
 */
export function normalizeCompletionRequest<T extends CompletionRequest>(req: T): T {
  const { response_format, stream, tools, temperature, max_tokens, options, ...rest } = req;
  if ([response_format, stream, tools, temperature, max_tokens].every(field => field === undefined)) {
    return req;
  }
  return {
    ...rest,
    options: {
      ...options,
      ...(response_format !== undefined && { response_format }),
      ...(stream !== undefined && { stream }),
      ...(tools !== undefined && { tools }),
      ...(temperature !== undefined && { temperature }),
      ...(max_tokens !== undefined && { maxTokens: max_tokens }),
    },
  } as T;
}
