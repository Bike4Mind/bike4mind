import {
  ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS,
  REASONING_SUPPORTED_MODELS,
  type ReasoningEffort,
} from '@bike4mind/common';
import {
  REASONING_EFFORT_SETTINGS,
  thinkingSwitchedOff,
  type ChatModelOption,
  type ReasoningEffortSetting,
} from '@shared/chat';
import { effortSent } from '@shared/generation';

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

/** The levels Desktop sent before models listed their own; see reasoningEffortFor. */
const UNLISTED_EFFORTS: readonly ReasoningEffortSetting[] = ['minimal', 'low', 'medium', 'high'];

/**
 * The effort to put on a request for `model`, or undefined to send none.
 *
 * Only a level the model's `controls.effort` lists, the nearest one when the setting is not
 * listed (see effortSent): main builds those from what the backend acts on (the server's
 * published levels for a hosted model, Ollama's `think` values, the gpt-oss levels of an
 * OpenAI-compatible server). Without a listed option, when the catalog could not be read, it
 * falls back to the adapters' own model sets and the levels every one of them takes.
 */
export function reasoningEffortFor(
  setting: ReasoningEffortSetting | undefined,
  model: string,
  option?: Pick<ChatModelOption, 'controls'>
): ReasoningEffort | undefined {
  if (!setting) return undefined;
  const levels = option?.controls
    ? (option.controls.effort?.levels ?? [])
    : supportsReasoningEffort(model)
      ? UNLISTED_EFFORTS
      : [];
  return effortSent(setting, levels);
}

/**
 * Whether a turn asks for thinking. Every model does except a `thinkingToggle` one switched off
 * (see thinkingSwitchedOff), and a turn sent at effort `none`: with thinking requested the server
 * keeps a Claude thinking and reads `none` as its lowest effort. Leaving the flag out is also what
 * makes the server send Ollama `think:false`, since a thinking-capable Ollama model otherwise thinks
 * by default.
 */
export function requestsThinking(
  setting: ReasoningEffortSetting | undefined,
  option: Pick<ChatModelOption, 'thinkingToggle' | 'minimalThinks' | 'controls'> | undefined,
  effort?: ReasoningEffort
): boolean {
  if (effort === 'none') return false;
  return !thinkingSwitchedOff(setting, option);
}
