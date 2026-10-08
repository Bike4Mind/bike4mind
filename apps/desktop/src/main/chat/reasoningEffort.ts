import {
  ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS,
  REASONING_SUPPORTED_MODELS,
  type ReasoningEffort,
} from '@bike4mind/common';
import { REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from '@shared/chat';

/** An unset or unrecognised value is `default`: a typo must not silently change how a model reasons. */
export function parseReasoningEffortSetting(raw: string | undefined): ReasoningEffortSetting {
  const value = raw?.trim().toLowerCase();
  return REASONING_EFFORT_SETTINGS.find(setting => setting === value) ?? 'default';
}

/** The setting a stored session really has, or null when the file carries none - see SessionStore.parse. */
export function storedReasoningEffortSetting(value: unknown): ReasoningEffortSetting | null {
  return REASONING_EFFORT_SETTINGS.find(setting => setting === value) ?? null;
}

/** Whether a reasoning effort may be sent with `model` at all. The picker is disabled when it may not. */
export function supportsReasoningEffort(model: string): boolean {
  return REASONING_SUPPORTED_MODELS.has(model) || ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS.has(model);
}

/**
 * The effort to put on a request for `model`, or undefined to send none.
 *
 * Gated on the adapters' own lists rather than a provider check: the server forwards the field
 * to whatever backend serves the model, and only these models accept it. Claude reads it only
 * because every desktop request also sets `thinking` (see completions.ts), and maps 'minimal'
 * to 'low' - see resolveAnthropicEffort in llm-adapters.
 */
export function reasoningEffortFor(
  setting: ReasoningEffortSetting | undefined,
  model: string
): ReasoningEffort | undefined {
  if (!setting || setting === 'default') return undefined;
  return supportsReasoningEffort(model) ? setting : undefined;
}
