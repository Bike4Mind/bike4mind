import { ChatModels, NO_TEMPERATURE_MODELS, type ReasoningEffort } from '@bike4mind/common';

/**
 * Request shaping for Moonshot's Kimi models. Kept separate from kimiBackend's
 * transport so every "which parameter does this id accept" rule is one pure
 * function with a test, rather than a conditional buried in a 400-line complete().
 *
 * Moonshot is OpenAI-compatible in envelope only. The reasoning controls, the
 * sampling pins, and the max-tokens parameter all differ per model, and sending
 * the wrong one is a 400 rather than a silently ignored field.
 * @see https://platform.kimi.ai/docs/api/chat
 */

/** Kimi's own effort vocabulary, which is not OpenAI's and not B4M's. */
export const KIMI_EFFORT_LEVELS = ['low', 'high', 'max'] as const;
export type KimiEffort = (typeof KIMI_EFFORT_LEVELS)[number];

/**
 * Takes `reasoning_effort`. K3 only, and K3 always reasons - there is no way to
 * turn thinking off, so the parameter selects depth, never whether.
 */
const EFFORT_MODELS: ReadonlySet<string> = new Set<string>([ChatModels.KIMI_K3]);

/** Takes the `thinking` object instead of `reasoning_effort`. */
const THINKING_MODELS: ReadonlySet<string> = new Set<string>([
  ChatModels.KIMI_K2_7_CODE,
  ChatModels.KIMI_K2_7_CODE_HIGHSPEED,
  ChatModels.KIMI_K2_6,
  ChatModels.KIMI_K2_5,
]);

/**
 * `thinking.type` accepts only 'enabled' on the K2.7 code models - 'disabled' is
 * rejected. So a caller asking for no thinking gets thinking anyway; the
 * alternative is a 400, and the parameter is omitted rather than fought.
 */
const THINKING_ALWAYS_ON: ReadonlySet<string> = new Set<string>([
  ChatModels.KIMI_K2_7_CODE,
  ChatModels.KIMI_K2_7_CODE_HIGHSPEED,
]);

/**
 * Rejects `tool_choice: 'required'` (auto and none are fine, as is the explicit
 * function form). Downgraded to 'auto' rather than dropped: a caller that asked
 * for a forced tool still wants tools offered.
 */
const NO_REQUIRED_TOOL_CHOICE: ReadonlySet<string> = new Set<string>([
  ChatModels.KIMI_K2_7_CODE,
  ChatModels.KIMI_K2_7_CODE_HIGHSPEED,
  ChatModels.KIMI_K2_6,
]);

/** Every Kimi id this build ships, direct-served. Bedrock-served Kimi is not here. */
export const KIMI_MODELS: ReadonlySet<string> = new Set<string>([
  ChatModels.KIMI_K3,
  ChatModels.KIMI_K2_7_CODE,
  ChatModels.KIMI_K2_7_CODE_HIGHSPEED,
  ChatModels.KIMI_K2_6,
  ChatModels.KIMI_K2_5,
]);

/**
 * B4M's six-level effort onto Kimi's three. 'none' and 'minimal' map to 'low'
 * rather than to omission because K3 cannot be asked not to think - claiming
 * otherwise by dropping the parameter would silently bill max-effort reasoning
 * (Moonshot's default is 'max').
 */
export function toKimiEffort(effort: ReasoningEffort | undefined): KimiEffort | undefined {
  if (!effort) return undefined;
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
      return 'high';
    case 'xhigh':
      return 'max';
    default:
      return undefined;
  }
}

export interface KimiReasoningInput {
  /** ICompletionOptions.thinking - budget_tokens has no Kimi equivalent and is dropped. */
  thinking?: { enabled: boolean; budget_tokens?: number };
  reasoningEffort?: ReasoningEffort;
}

/**
 * The reasoning parameters for one model, or an empty object when it takes none.
 * Mutually exclusive by construction: no Kimi model accepts both spellings, and
 * sending both is a 400.
 */
export function kimiReasoningParams(model: string, input: KimiReasoningInput): Record<string, unknown> {
  if (EFFORT_MODELS.has(model)) {
    const effort = toKimiEffort(input.reasoningEffort);
    // Omitted means Moonshot's documented default of 'max'. Left alone on
    // purpose: an unrequested downgrade would quietly change answer quality.
    return effort ? { reasoning_effort: effort } : {};
  }

  if (THINKING_MODELS.has(model)) {
    if (THINKING_ALWAYS_ON.has(model)) {
      // keep is always treated as 'all' here regardless of what we send, so it
      // is not sent.
      return { thinking: { type: 'enabled' } };
    }
    if (input.thinking?.enabled === undefined) return {};
    return { thinking: { type: input.thinking.enabled ? 'enabled' : 'disabled' } };
  }

  return {};
}

/**
 * Sampling parameters for one model. Moonshot pins temperature (1.0) and top_p
 * (0.95) on every current Kimi and documents them as unmodifiable, so they are
 * omitted rather than sent-and-ignored; NO_TEMPERATURE_MODELS is the shared set
 * the catalog's temperatureMode also lands on.
 *
 * The penalties and `n` ride the same gate. Moonshot documents the whole sampling
 * group as fixed on these ids, B4M sends penalties on essentially every turn, and
 * an unmodifiable parameter here is a 400 rather than a silently ignored field -
 * so the conservative reading is the safe one. Only the moonshot-v1 family, which
 * this build does not ship, accepts any of them.
 */
export function kimiSamplingParams(
  model: string,
  input: {
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    n?: number;
  }
): Record<string, unknown> {
  if (NO_TEMPERATURE_MODELS.has(model)) return {};
  const params: Record<string, unknown> = {};
  if (input.temperature !== undefined) params.temperature = input.temperature;
  if (input.topP !== undefined) params.top_p = input.topP;
  if (input.presencePenalty !== undefined) params.presence_penalty = input.presencePenalty;
  if (input.frequencyPenalty !== undefined) params.frequency_penalty = input.frequencyPenalty;
  if (input.n !== undefined) params.n = input.n;
  return params;
}

export type KimiToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/** `tool_choice`, downgraded to 'auto' on the ids that reject 'required'. */
export function kimiToolChoice(model: string, choice: KimiToolChoice | undefined): KimiToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (choice === 'required' && NO_REQUIRED_TOOL_CHOICE.has(model)) return 'auto';
  return choice;
}
