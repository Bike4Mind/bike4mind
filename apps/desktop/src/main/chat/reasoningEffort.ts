import { REASONING_SUPPORTED_MODELS, type ReasoningEffort } from '@bike4mind/common';

/** `default` sends nothing, leaving the provider at its own effort. */
export type ReasoningEffortSetting = 'default' | Extract<ReasoningEffort, 'minimal' | 'low' | 'medium' | 'high'>;

const SETTINGS: readonly ReasoningEffortSetting[] = ['default', 'minimal', 'low', 'medium', 'high'];

/** An unset or unrecognised value is `default`: a typo must not silently change how a model reasons. */
export function parseReasoningEffortSetting(raw: string | undefined): ReasoningEffortSetting {
  const value = raw?.trim().toLowerCase();
  return SETTINGS.find(setting => setting === value) ?? 'default';
}

/**
 * The effort to put on a request for `model`, or undefined to send none.
 *
 * Gated on the adapter's own list rather than a provider check: the server forwards the field
 * to whatever backend serves the model, and only these models accept it. Claude is outside the
 * list and has its own thinking settings.
 */
export function reasoningEffortFor(
  setting: ReasoningEffortSetting | undefined,
  model: string
): ReasoningEffort | undefined {
  if (!setting || setting === 'default') return undefined;
  return REASONING_SUPPORTED_MODELS.has(model) ? setting : undefined;
}
