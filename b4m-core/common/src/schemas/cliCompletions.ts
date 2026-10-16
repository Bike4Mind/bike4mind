import { z } from 'zod';
import { MAX_THINKING_BUDGET_TOKENS } from '../constants/llmLimits';
// Specific file, not the `../types` barrel - this module is imported by
// completions.contract.ts, which must stay off the barrel (see the note there).
import { QUEST_ERROR_CODES } from '../types/entities/SessionTypes';
import type { ReasoningEffort } from '../types/common';
import type { ApiErrorCode } from '../apiErrorCodes';

/**
 * The cross-provider effort vocabulary, deliberately NOT any one provider's.
 *
 * It is OpenAI's `reasoning_effort` levels, which the OpenAI path forwards verbatim.
 * Every other backend translates: Kimi and DeepSeek collapse these six onto their three
 * (toKimiEffort / toDeepSeekEffort), and Anthropic maps them onto `output_config.effort`
 * (toAnthropicEffort). Anthropic's five levels are 'low' | 'medium' | 'high' | 'xhigh' |
 * 'max', so the two vocabularies disagree at both ends: 'none' and 'minimal' have no
 * Anthropic effort level (on Claude, 'none' turns thinking off where the model allows
 * it, and otherwise both resolve to 'low', the least effort Anthropic can express), and 'max' is
 * absent here because adding it would also hand an invalid value to OpenAI's
 * `reasoning_effort`. Anthropic's 'max' is reached through
 * `ICompletionOptions.anthropicEffort` instead, which is typed in Anthropic's vocabulary.
 */
const REASONING_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly ReasoningEffort[];
export const CompletionReasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);

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
  model: z.string().max(256),
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
      reasoningEffort: CompletionReasoningEffortSchema.optional().describe(
        'Reasoning effort hint. Honoured by the OpenAI (reasoning models only, and not alongside tools on some of them), Kimi (K3 only), DeepSeek and Anthropic Claude (direct and Bedrock) adapters; each maps it onto its own scale. On Claude, `none` turns thinking off where the model allows it (otherwise it runs at the lowest effort), so short `max_tokens` replies stream visible text from the start; `minimal` maps to `low`. When `thinking.enabled` is also set on a Claude model, thinking stays on and this sets its effort instead, with `none` and `minimal` mapping to `low`. Claude models that reason inside `max_tokens` never have that ceiling raised, and on older Claude models any level above `none` turns thinking on (it is off by default there), forces temperature to 1 and drops top_p, and a thinking budget that cannot fit under `max_tokens` is skipped. On the direct Anthropic API, a json_schema `response_format` with no tools is served by a forced tool on models that support forced tool use, and that tool cannot run alongside thinking, so there only `none` is honoured; models served by native structured outputs honour every level. Silently ignored by every other adapter (Gemini, xAI, Ollama) and by non-reasoning models, so sending it there is a no-op.'
      ),
      thinking: z
        .object({
          enabled: z.boolean(),
          // 1024 is the smallest legacy thinking budget the Anthropic API accepts.
          budget_tokens: z.number().int().min(1024).max(MAX_THINKING_BUDGET_TOKENS).optional(),
        })
        .optional()
        .describe(
          'Ask a model that can think to think on this turn. On Claude, `reasoningEffort` then sets how much it thinks, and `budget_tokens` (default 16000, minimum 1024, maximum 32000) sizes thinking on older Claude models. Ignored by models that cannot think, and on the direct Anthropic API when a json_schema `response_format` is served by a forced tool, which cannot run alongside thinking.'
        ),
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

// --- Completions SSE response events ---
// Plain Zod (no `.openapi()`) so any runtime can import them; the OpenAPI layer
// annotates them via the contract. MUST stay in sync with the SSE event builders
// in utils/sseEvents.ts (the wire shapes the completions handler emits).

const CompletionUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z
    .number()
    .optional()
    .describe(
      'Reasoning/thinking tokens the provider reported. A subset of outputTokens, not additive and not billed on top. Absent when the provider or adapter reports no count.'
    ),
  cacheReadInputTokens: z.number().optional(),
  cacheCreationInputTokens: z.number().optional(),
});

const CompletionMetaEventSchema = z.object({
  type: z.literal('meta'),
  requestId: z.string(),
});

const CompletionContentEventSchema = z.object({
  type: z.enum(['content', 'tool_use']),
  text: z.string(),
  tools: z
    .array(z.object({ name: z.string(), arguments: z.string().optional(), id: z.string().optional() }))
    .optional(),
  usage: CompletionUsageSchema.optional(),
  credits: z.object({ used: z.number().optional(), usdCost: z.number().optional() }).optional(),
  responseFormatMode: z.enum(['native', 'tool_use', 'best-effort']).optional(),
  // Why generation ended, on the terminal event. Normalized vocabulary (see stopReasons.ts):
  // 'max_tokens' means the reply was CUT OFF, not finished. Left as a plain string rather
  // than an enum so a new or provider-specific reason reaches clients instead of failing
  // validation at the boundary.
  stopReason: z.string().optional(),
  // Complete assistant message incl. reasoning blocks (Anthropic extended thinking with tools).
  thinking: z.array(z.any()).optional(),
  // A tool call the model has begun writing; see CompletionInfo.toolStarted.
  toolStarted: z.object({ name: z.string(), id: z.string().optional() }).optional(),
});

/**
 * Classifiers the completions `error` frame may carry: the persisted quest codes plus the two
 * provider codes. A separate tuple because QUEST_ERROR_CODES is stored on quests and must not widen.
 */
export const COMPLETION_SSE_ERROR_CODES = [
  ...QUEST_ERROR_CODES,
  'provider_error',
  'provider_rejected',
  'content_blocked',
] as const satisfies readonly ApiErrorCode[];
export type CompletionSseErrorCode = (typeof COMPLETION_SSE_ERROR_CODES)[number];

/**
 * The in-band terminal failure frame, sent only once the stream has opened. Failures found before
 * the provider call (auth, scope, validation, rate limit, model, credits) are JSON errors with a
 * real status instead; see completions.contract.ts.
 *
 * `code` is the machine-readable classifier: a billing code when settlement runs out mid-generation,
 * `provider_rejected` / `provider_error` when the model provider fails, `content_blocked` when the
 * model's safety classifier declined the request. Optional; callers must never match on the prose
 * `message`.
 *
 * The field is `code` rather than the conventions' `errorCode` because this frame shipped that way
 * and is a published wire shape.
 */
export const CompletionSseErrorEventSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  requestId: z.string().optional(),
  code: z.enum(COMPLETION_SSE_ERROR_CODES).optional(),
});

/** One `data:` event in the `text/event-stream` completions response. */
export const CompletionStreamEventSchema = z.union([
  CompletionMetaEventSchema,
  CompletionContentEventSchema,
  CompletionSseErrorEventSchema,
]);

export type CompletionStreamEvent = z.infer<typeof CompletionStreamEventSchema>;
