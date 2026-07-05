import { NO_TEMPERATURE_MODELS, type ModelInfo } from '@bike4mind/common';

/**
 * Thinking parameter shapes for the Anthropic Messages API.
 *
 * - Legacy (Claude 3.7 through 4.6): `thinking: { type: "enabled", budget_tokens }`
 * - Adaptive (Claude 4.7+): `thinking: { type: "adaptive" }` + `output_config: { effort }`
 */
export type ThinkingConfig =
  | { thinking: { type: 'enabled'; budget_tokens: number }; output_config?: never }
  | { thinking: { type: 'adaptive' }; output_config: { effort: 'high' | 'medium' | 'low' } };

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
    const adaptiveFloor = 64_000;
    const maxTokens = Math.max(currentMaxTokens, adaptiveFloor);

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
