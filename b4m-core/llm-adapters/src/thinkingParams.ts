import { ChatModels, NO_TEMPERATURE_MODELS, type ModelInfo } from '@bike4mind/common';

/**
 * Thinking parameter shapes for the Anthropic Messages API.
 *
 * - Legacy (Claude 3.7 through 4.6): `thinking: { type: "enabled", budget_tokens }`
 * - Adaptive (Claude 4.7+): `thinking: { type: "adaptive" }` + `output_config: { effort }`
 */
export type ThinkingConfig =
  | { thinking: { type: 'enabled'; budget_tokens: number }; output_config?: never }
  | { thinking: { type: 'adaptive' }; output_config: { effort: 'high' | 'medium' | 'low' } };

/**
 * max_tokens floor for adaptive reasoning models (Claude 4.7+/Opus 5). These
 * models self-manage extended thinking *within* max_tokens, which is a ceiling
 * (they stop at end_turn), not a target - so a larger floor costs nothing on
 * short replies but keeps reasoning from consuming the whole budget and leaving
 * no room for the visible answer. Both paths that size an adaptive model's output
 * budget read it from here: buildThinkingParams (thinking explicitly enabled) and
 * resolveOutputMaxTokens (the default when a caller names no budget), which also
 * applies it to the non-Anthropic ids in REASONS_WITHIN_OUTPUT_BUDGET.
 */
export const ADAPTIVE_THINKING_MAX_TOKENS_FLOOR = 64_000;

/**
 * Models that always reason, and spend the reasoning INSIDE max_tokens without
 * adding to it - the same budget shape as Anthropic's adaptive models, which are
 * recognized by thinkingStyle instead and so are not listed here.
 *
 * On these ids a small default budget is not "a shorter answer": the monologue
 * consumes the whole thing and generation stops mid-thought, so the reply is a
 * reasoning trace with no answer after it at all. Bedrock's Kimi copies inline
 * that monologue in `content` (see bedrockBackend/moonshot.ts) and cap output at
 * 16K, so the floor below clamps to 16K for them - the entire budget, which is
 * the only value that leaves room for an answer after a long trace.
 */
const REASONS_WITHIN_OUTPUT_BUDGET: ReadonlySet<string> = new Set<string>([
  ChatModels.KIMI_K2_THINKING_BEDROCK,
  ChatModels.KIMI_K2_5_BEDROCK,
]);

/**
 * Resolves the output budget to send as max_tokens.
 *
 * The distinction that matters: `requested` being undefined means the caller
 * expressed no preference, which is the only case we are free to size for the
 * model. An explicit number is a deliberate choice and is never raised - raising
 * it would silently exceed the budget the caller asked for, and it also feeds the
 * credit pre-reservation and shrinks the usable input window, so a "harmless"
 * bump is neither harmless nor invisible. Explicit values are still clamped down
 * to the model's own cap, since over-requesting 400s the whole turn.
 *
 * Models that reason inside max_tokens default to ADAPTIVE_THINKING_MAX_TOKENS_FLOOR
 * (clamped to their own cap): a small default can be consumed entirely by reasoning,
 * leaving an empty visible reply. That is Anthropic's adaptive models by
 * thinkingStyle, plus the ids in REASONS_WITHIN_OUTPUT_BUDGET.
 */
export function resolveOutputMaxTokens({
  requested,
  fallback,
  thinkingStyle,
  modelMaxOutputTokens,
  model,
}: {
  requested: number | undefined;
  /** Default for models that do not reason inside the output budget. */
  fallback: number;
  thinkingStyle: ModelInfo['thinkingStyle'];
  modelMaxOutputTokens: number;
  /** Model id, for the id-keyed set above. Absent means no id-keyed quirk applies. */
  model?: string;
}): number {
  const reasonsWithinBudget =
    thinkingStyle === 'adaptive' || (model !== undefined && REASONS_WITHIN_OUTPUT_BUDGET.has(model));
  const preferred = requested ?? (reasonsWithinBudget ? ADAPTIVE_THINKING_MAX_TOKENS_FLOOR : fallback);
  return Math.min(preferred, modelMaxOutputTokens);
}

export interface ThinkingResult {
  /** The thinking parameter object to spread into the API request body */
  thinkingConfig: ThinkingConfig;
  /** The max_tokens value to use (ensures headroom beyond thinking budget) */
  maxTokens: number;
  /** Temperature constraint: set to 1 for legacy thinking, delete for NO_TEMPERATURE_MODELS */
  temperature: number | 'delete';
}

/**
 * Builds the correct thinking parameters for an Anthropic API call based on
 * the model's thinkingStyle. Handles legacy vs adaptive API contracts,
 * max_tokens floor, and temperature/top_p constraints.
 *
 * @param model - The model ID string
 * @param modelInfo - The ModelInfo object for this model
 * @param budgetTokens - The desired thinking budget (used for legacy models; ignored for adaptive)
 * @param currentMaxTokens - The caller-supplied max_tokens value
 * @param effort - The effort level for adaptive models (default: 'high')
 */
export function buildThinkingParams(
  model: string,
  modelInfo: ModelInfo,
  budgetTokens: number,
  currentMaxTokens: number,
  effort: 'high' | 'medium' | 'low' = 'high'
): ThinkingResult {
  const isAdaptive = modelInfo.thinkingStyle === 'adaptive';
  const rejectsTemperature = NO_TEMPERATURE_MODELS.has(model);

  if (isAdaptive) {
    // Adaptive models self-manage thinking allocation within max_tokens, and
    // max_tokens is a *ceiling* (they stop at end_turn) - not a target - so a
    // larger floor costs nothing on normal short replies but prevents large
    // artifacts from colliding with the extended-thinking budget. At 32K a
    // ~10-11K-token HTML artifact plus high-effort thinking could exceed the
    // shared budget and get truncated mid-tag; 64K leaves ample room
    // for both while staying well under these models' 128K output capability.
    const maxTokens = Math.max(currentMaxTokens, ADAPTIVE_THINKING_MAX_TOKENS_FLOOR);

    return {
      thinkingConfig: {
        thinking: { type: 'adaptive' },
        output_config: { effort },
      },
      maxTokens,
      temperature: rejectsTemperature ? 'delete' : 1,
    };
  }

  // Legacy models: explicit budget_tokens, inflate max_tokens to fit
  const maxTokens = Math.max(currentMaxTokens, budgetTokens + 1000);

  return {
    thinkingConfig: {
      thinking: { type: 'enabled', budget_tokens: budgetTokens },
    },
    maxTokens,
    temperature: rejectsTemperature ? 'delete' : 1,
  };
}
