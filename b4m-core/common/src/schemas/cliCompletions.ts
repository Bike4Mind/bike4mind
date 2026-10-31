import { z } from 'zod';
import { ModelIdSchema } from './modelId';
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
export const CompletionCustomToolSchema = z.object({
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
    defer_loading: z
      .boolean()
      .optional()
      .describe(
        'Keep this definition out of the model context until the tool search server tool (or a `tool_reference`) loads it. ' +
          'Honoured only on Claude models (direct Anthropic or Bedrock) whose `supports_tool_search` is true; on every other ' +
          'model it is ignored and the tool is sent as usual. At least one tool, ' +
          'or a `serverTool` entry, must stay non-deferred (`errorCode: "all_tools_deferred"`).'
      ),
    cache_control: z
      .unknown()
      .optional()
      .describe(
        'Accepted for validation only and not forwarded. Rejected on a deferred tool (`errorCode: "deferred_tool_cache_control"`).'
      ),
  }),
  _isMcpTool: z.boolean().optional(),
});

export type CompletionCustomTool = z.infer<typeof CompletionCustomToolSchema>;

/** Anthropic's tool search server tools; `name` is fixed by `type`. */
export const ToolSearchServerToolSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool_search_tool_regex_20251119'), name: z.literal('tool_search_tool_regex') }),
  z.object({ type: z.literal('tool_search_tool_bm25_20251119'), name: z.literal('tool_search_tool_bm25') }),
]);

export type ToolSearchServerTool = z.infer<typeof ToolSearchServerToolSchema>;

export const CompletionServerToolSchema = z.object({
  serverTool: ToolSearchServerToolSchema.describe(
    'A provider-run tool, sent to the provider as `{ type, name }`. Only the Anthropic tool search tools exist today, and ' +
      'only on Claude models (direct Anthropic or Bedrock) whose `supports_tool_search` is true; any other model is ' +
      'refused with `errorCode: "tool_search_unsupported"` rather than run without it.'
  ),
});

export type CompletionServerTool = z.infer<typeof CompletionServerToolSchema>;

/** One `tools[]` entry: a caller-defined tool, or a provider-run server tool. */
export const CompletionToolSchema = z.union([CompletionCustomToolSchema, CompletionServerToolSchema]);

export type CompletionTool = z.infer<typeof CompletionToolSchema>;

export function isCompletionServerTool(tool: CompletionTool): tool is CompletionServerTool {
  return 'serverTool' in tool;
}

/**
 * The `errorCode`s of the completions 400s for tool search requests (CONVENTIONS.md section 1).
 * Assigned in services/cliCompletionsToolSearch.ts.
 */
export const COMPLETION_TOOL_ERROR_CODES = [
  'tool_search_unsupported',
  'all_tools_deferred',
  'deferred_tool_cache_control',
  'unknown_tool_reference',
  'tool_changes_unsupported',
  'invalid_tool_change',
] as const satisfies readonly ApiErrorCode[];
export type CompletionToolErrorCode = (typeof COMPLETION_TOOL_ERROR_CODES)[number];

export const ASSISTANT_PREFILL_UNSUPPORTED_ERROR_CODE = 'assistant_prefill_unsupported' as const satisfies ApiErrorCode;

export const TOOL_CHANGE_BLOCK_TYPES = ['tool_addition', 'tool_removal'] as const;

/**
 * One block of a mid-conversation tool change: a `system`-role message whose content holds only these.
 * Strict on purpose: the provider takes a name reference to a tool already in `tools`, never an inline
 * definition or an MCP reference.
 */
export const ToolChangeBlockSchema = z
  .object({
    type: z.enum(TOOL_CHANGE_BLOCK_TYPES),
    tool: z.object({ type: z.literal('tool_reference'), name: z.string().min(1) }).strict(),
  })
  .strict();

export type ToolChangeBlock = z.infer<typeof ToolChangeBlockSchema>;

export const ToolChangeMessageContentSchema = z.array(ToolChangeBlockSchema).min(1);

/** Whether a content block is shaped like a tool change, whether or not it is a valid one. */
export function isToolChangeBlockType(block: unknown): boolean {
  const type = (block as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' && (TOOL_CHANGE_BLOCK_TYPES as readonly string[]).includes(type);
}

/**
 * A system message of tool change blocks. Unlike every other system message it is not hoisted into the
 * provider's system prompt: its position between turns is the point. Shared by the request validation
 * (services/cliCompletionsToolSearch.ts) and the Anthropic adapter, which must agree on what counts.
 */
export function isToolChangeMessage(message: { role: string; content?: unknown }): boolean {
  return message.role === 'system' && Array.isArray(message.content) && message.content.some(isToolChangeBlockType);
}

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
  content: z
    .union([z.string(), z.array(z.any())])
    .describe(
      'A string, or an array of content blocks. A `system` message may instead hold only `tool_addition` / ' +
        '`tool_removal` blocks (`{ type, tool: { type: "tool_reference", name } }`) to load or unload a tool named in ' +
        '`tools` mid-conversation without invalidating the prompt cache. It must follow a user turn or an assistant turn ' +
        'ending in a tool search result, and be the last message or precede an assistant turn. Only on models whose ' +
        '`supports_tool_changes` is true and that are served by the direct Anthropic API; otherwise refused with ' +
        '`errorCode: "tool_changes_unsupported"` (or `invalid_tool_change` / `unknown_tool_reference` when malformed). ' +
        'A final non-blank assistant turn is an assistant prefill, except a server-tool continuation ending in ' +
        '`server_tool_use` or `tool_search_tool_result`. Plain system prompts and blank messages are ignored. It is accepted only ' +
        'when the selected model has `supports_assistant_prefill: true`; otherwise the request returns `400` with ' +
        '`errorCode: "assistant_prefill_unsupported"` without changing the message.'
    ),
  cache: z.boolean().optional(),
});

export type CompletionMessage = z.infer<typeof CompletionMessageSchema>;

/**
 * The caller's own conversation id. Recorded on the credit ledger row so spend can be traced back
 * to a conversation; never used for authorization or lookups.
 */
export const CompletionSessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "Your own identifier for the conversation this request belongs to. Recorded with the request's credit usage so spend can be grouped by conversation. Not interpreted otherwise."
  );

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
  model: ModelIdSchema,
  messages: z.array(CompletionMessageSchema).min(1),
  response_format: ResponseFormatSchema.optional(),
  stream: z.boolean().optional(),
  tools: z.array(CompletionToolSchema).optional(),
  temperature: z.number().optional(),
  // OpenAI wire naming; normalizes into options.maxTokens alongside the legacy `maxTokens` alias.
  max_tokens: z.number().optional(),
  sessionId: CompletionSessionIdSchema.optional(),
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
      cacheTtl: z
        .enum(['5m', '1h'])
        .optional()
        .describe(
          'Prompt-cache lifetime for this request, where the server places cache breakpoints (Claude on the direct Anthropic API or Bedrock, on requests the server caches: CLI and Desktop always, other callers once the conversation has a prior assistant turn). `5m` (the default) writes at 1.25x the input rate; `1h` writes at 2x and keeps the cached prefix for an hour between requests. Reads cost the same either way. Models without 1-hour caching ignore `1h` and keep `5m`. Every breakpoint in a request must share one TTL: with `1h`, set no `cache_control` of your own unless it also carries `ttl: "1h"`.'
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
  cacheWrite1hInputTokens: z
    .number()
    .optional()
    .describe('The part of cacheCreationInputTokens written with the 1-hour TTL. Absent when there were none.'),
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
  'invalid_request',
  'provider_error',
  'provider_rejected',
  'content_blocked',
  'output_budget_exhausted',
] as const satisfies readonly ApiErrorCode[];
export type CompletionSseErrorCode = (typeof COMPLETION_SSE_ERROR_CODES)[number];

/**
 * The in-band terminal failure frame, sent only once the stream has opened. Failures found before
 * the provider call (auth, scope, validation, rate limit, model, credits) are JSON errors with a
 * real status instead; see completions.contract.ts.
 *
 * `code` is the machine-readable classifier: a billing code when settlement runs out mid-generation,
 * `invalid_request` when the provider rejects caller-controlled input, `provider_rejected` /
 * `provider_error` when the model provider fails, `content_blocked` when the model's safety classifier
 * declined the request, `output_budget_exhausted` when a reasoning model spent the caller's whole `max_tokens` thinking. Optional; callers must never match on the prose `message`.
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

/** Anthropic content block types the provider runs itself; surfaced as `provider_block` frames and echoed back. */
export const TOOL_SEARCH_BLOCK_TYPES: ReadonlySet<string> = new Set(['server_tool_use', 'tool_search_tool_result']);

/**
 * A provider content block the caller must echo back verbatim, in stream order, in the assistant
 * `messages` content of the next request: today the Anthropic tool search `server_tool_use` and
 * `tool_search_tool_result` blocks. Never executed by the caller and never answered with a tool_result.
 */
export const CompletionProviderBlockEventSchema = z.object({
  type: z.literal('provider_block'),
  provider: z.literal('anthropic'),
  block: z.record(z.string(), z.unknown()),
});

/** One `data:` event in the `text/event-stream` completions response. */
export const CompletionStreamEventSchema = z.union([
  CompletionMetaEventSchema,
  CompletionContentEventSchema,
  CompletionProviderBlockEventSchema,
  CompletionSseErrorEventSchema,
]);

export type CompletionStreamEvent = z.infer<typeof CompletionStreamEventSchema>;
