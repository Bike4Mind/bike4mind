import { ChatModels, type ReasoningEffort } from '@bike4mind/common';

/**
 * Request shaping for DeepSeek's direct API. Kept out of deepseekBackend's
 * transport for the same reason kimiParams is: every "which parameter does this
 * id accept" rule is one pure function with a test next to it, rather than a
 * conditional buried in a 400-line complete().
 *
 * DeepSeek is OpenAI-compatible in envelope. What differs is thinking mode -
 * on by default on both ids, with its own toggle, its own effort vocabulary,
 * and a sampling group that is IGNORED rather than rejected while it is on.
 * @see https://api-docs.deepseek.com/guides/thinking_mode
 */

/** DeepSeek's effort vocabulary, which is not OpenAI's and not B4M's. */
export const DEEPSEEK_EFFORT_LEVELS = ['low', 'high', 'max'] as const;
export type DeepSeekEffort = (typeof DEEPSEEK_EFFORT_LEVELS)[number];

/**
 * Every DeepSeek id this build ships, direct-served. Bedrock-served DeepSeek is
 * not here. Both the reasoning and the sampling shaper gate on THIS set, so the
 * two cannot disagree about which ids the rules apply to; a test pins it against
 * the adapter table and against NO_TEMPERATURE_MODELS.
 */
export const DEEPSEEK_MODELS: ReadonlySet<string> = new Set<string>([
  ChatModels.DEEPSEEK_FLASH,
  ChatModels.DEEPSEEK_V4_PRO,
]);

/** DeepSeek raises anything below this rather than erroring, so we send what it will use. */
export const DEEPSEEK_THINKING_TOP_P_FLOOR = 0.95;

/** The `stop` array is capped at 16 sequences. */
export const DEEPSEEK_MAX_STOP_SEQUENCES = 16;

/**
 * B4M's six-level effort onto DeepSeek's three. 'none' and 'minimal' map to
 * 'low' rather than to omission: omitting the parameter leaves DeepSeek's
 * documented default of 'high', so dropping it on a "least effort" request
 * would bill more reasoning than was asked for, not less.
 */
export function toDeepSeekEffort(effort: ReasoningEffort | undefined): DeepSeekEffort | undefined {
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

export interface DeepSeekReasoningInput {
  /** ICompletionOptions.thinking - budget_tokens has no DeepSeek equivalent and is dropped. */
  thinking?: { enabled: boolean; budget_tokens?: number };
  reasoningEffort?: ReasoningEffort;
}

/**
 * The reasoning parameters for one model, or an empty object when it takes none.
 *
 * Both spellings are OpenAI-format and independent, unlike Kimi where they are
 * mutually exclusive: `thinking.type` turns reasoning on or off and
 * `reasoning_effort` sets its depth. DeepSeek's own example sends both in one
 * request. Omitting both leaves thinking enabled at effort 'high'.
 */
export function deepseekReasoningParams(model: string, input: DeepSeekReasoningInput = {}): Record<string, unknown> {
  if (!DEEPSEEK_MODELS.has(model)) return {};

  const params: Record<string, unknown> = {};
  if (input.thinking?.enabled !== undefined) {
    params.thinking = { type: input.thinking.enabled ? 'enabled' : 'disabled' };
  }
  // Effort is meaningless once thinking is off, and there is no 'none' level to
  // express the request with, so it is dropped rather than contradicting the toggle.
  if (input.thinking?.enabled === false) return params;

  const effort = toDeepSeekEffort(input.reasoningEffort);
  if (effort) params.reasoning_effort = effort;
  return params;
}

/**
 * Whether the turn will reason, which is what the sampling restrictions below
 * actually hang on. DeepSeek's default is enabled, so only an explicit
 * `thinking.enabled === false` turns it off.
 */
export function deepseekThinkingEnabled(input: DeepSeekReasoningInput = {}): boolean {
  return input.thinking?.enabled !== false;
}

/**
 * Sampling parameters for one turn.
 *
 * In thinking mode - the default on both ids - DeepSeek documents temperature,
 * presence_penalty and frequency_penalty as unsupported. They are accepted and
 * SILENTLY ignored rather than rejected, which is the worse failure of the two:
 * a 400 tells you the knob is dead, a no-op does not. They are dropped here so
 * nothing is sent that cannot take effect.
 *
 * Keyed on the TURN's resolved thinking state, not on model id: the restriction
 * is a property of thinking mode and the caller can turn thinking off, in which
 * case dropping temperature anyway would reproduce the same silent no-op from
 * our side of the wire.
 *
 * `top_p` does work in thinking mode with a lower bound of 0.95: a smaller value
 * is raised to it. Sent clamped rather than dropped, so the request states the
 * value the server will actually apply. The floor is a thinking-mode rule, so it
 * does not apply once thinking is off.
 *
 * `n` is not in DeepSeek's schema in either mode and is never sent.
 */
export function deepseekSamplingParams(
  model: string,
  input: {
    temperature?: number;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
  },
  reasoning: DeepSeekReasoningInput = {}
): Record<string, unknown> {
  if (!DEEPSEEK_MODELS.has(model) || !deepseekThinkingEnabled(reasoning)) {
    const passthrough: Record<string, unknown> = {};
    if (input.temperature !== undefined) passthrough.temperature = input.temperature;
    if (input.topP !== undefined) passthrough.top_p = input.topP;
    if (input.presencePenalty !== undefined) passthrough.presence_penalty = input.presencePenalty;
    if (input.frequencyPenalty !== undefined) passthrough.frequency_penalty = input.frequencyPenalty;
    return passthrough;
  }

  if (input.topP === undefined) return {};
  return { top_p: Math.max(input.topP, DEEPSEEK_THINKING_TOP_P_FLOOR) };
}

/** `stop`, truncated to the 16 sequences DeepSeek accepts. */
export function deepseekStopSequences(
  stop: string | string[] | null | undefined
): string | string[] | null | undefined {
  if (!Array.isArray(stop)) return stop;
  return stop.length > DEEPSEEK_MAX_STOP_SEQUENCES ? stop.slice(0, DEEPSEEK_MAX_STOP_SEQUENCES) : stop;
}
