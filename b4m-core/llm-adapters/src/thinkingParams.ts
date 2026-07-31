import { NO_TEMPERATURE_MODELS, REASONING_SUPPORTED_MODELS, type ModelInfo } from '@bike4mind/common';

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
 * resolveOutputMaxTokens (the default when a caller names no budget).
 */
export const ADAPTIVE_THINKING_MAX_TOKENS_FLOOR = 64_000;

/**
 * Room reserved for the visible answer above a legacy thinking budget. The API rejects a
 * thinking budget that is not strictly below max_tokens, and a budget that merely squeaks
 * under it starves the answer instead, so anything that moves either value has to preserve
 * this gap - see the non-streaming clamp in anthropicBackend.
 */
export const THINKING_ANSWER_HEADROOM_TOKENS = 1000;

/**
 * Whether the model spends reasoning tokens inside its output budget on every turn,
 * which is what makes a small budget produce an empty visible reply rather than a
 * short one. Provider-agnostic on purpose: the trap is identical whether the tokens
 * are Anthropic extended thinking inside max_tokens or OpenAI reasoning inside
 * max_completion_tokens.
 *
 * Deliberately NOT keyed on can_think alone. Anthropic legacy models set it too, but
 * their thinking is opt-in and separately budgeted, so they do not starve at a small
 * default and should not pay for headroom they will not use.
 *
 * The last clause is the catalog-only case: a reasoning-shaped model we never
 * hardcoded still declares a reasoning-shaped max-tokens param, which openaiBackend
 * already pairs with can_think for the same "not in our tables" reason.
 */
export function reasonsWithinOutputBudget(modelInfo: ModelInfo): boolean {
  if (modelInfo.thinkingStyle === 'adaptive') return true;
  if (REASONING_SUPPORTED_MODELS.has(modelInfo.id)) return true;
  return modelInfo.dispatchProfile?.maxTokensParam === 'max_completion_tokens' && modelInfo.can_think === true;
}

/**
 * Resolves the output budget to send as the model's max-tokens param.
 *
 * The distinction that matters: `requested` being undefined means the caller
 * expressed no preference, which is the only case we are free to size for the
 * model. An explicit number is a deliberate choice and is never raised - raising
 * it would silently exceed the budget the caller asked for, and it also feeds the
 * credit pre-reservation and shrinks the usable input window, so a "harmless"
 * bump is neither harmless nor invisible. Explicit values are still clamped down
 * to the model's own cap, since over-requesting 400s the whole turn.
 *
 * Models that reason inside the output budget default to
 * ADAPTIVE_THINKING_MAX_TOKENS_FLOOR: a small default can be consumed entirely by
 * reasoning, leaving an empty visible reply.
 */
export function resolveOutputMaxTokens({
  requested,
  fallback,
  modelInfo,
  modelMaxOutputTokens,
}: {
  requested: number | undefined;
  /** Default for models that do not reason inside the output budget. */
  fallback: number;
  modelInfo: ModelInfo;
  modelMaxOutputTokens: number;
}): number {
  const preferred = requested ?? (reasonsWithinOutputBudget(modelInfo) ? ADAPTIVE_THINKING_MAX_TOKENS_FLOOR : fallback);
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
  const maxTokens = Math.max(currentMaxTokens, budgetTokens + THINKING_ANSWER_HEADROOM_TOKENS);

  return {
    thinkingConfig: {
      thinking: { type: 'enabled', budget_tokens: budgetTokens },
    },
    maxTokens,
    temperature: rejectsTemperature ? 'delete' : 1,
  };
}
