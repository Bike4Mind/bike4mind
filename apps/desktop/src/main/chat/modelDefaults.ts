import { thinkingSwitchedOff, type ChatModelOption, type ReasoningEffortSetting } from '@shared/chat';
import { catalogSeed, layeredGeneration, requestGeneration, type GenerationSettings } from '@shared/generation';
import type { ModelSettings } from '@shared/modelSettings';
import type { ReasoningEffort } from '@bike4mind/common';

type TurnOption = Pick<ChatModelOption, 'thinkingToggle' | 'thinkingAlwaysOn' | 'minimalThinks' | 'controls'>;

/** The effort setting a turn runs at: the model's default stands in for the conversation's `default`. */
export function turnEffortSetting(
  setting: ReasoningEffortSetting,
  defaults: ModelSettings | undefined,
  option: TurnOption | undefined
): ReasoningEffortSetting {
  return setting === 'default' && defaults?.effort && option?.controls?.effort ? defaults.effort : setting;
}

/** Whether a turn thinks, which picks the catalog sampling it is seeded from. A model that cannot think does not. */
export function turnThinks(
  setting: ReasoningEffortSetting,
  option: TurnOption | undefined,
  effort: ReasoningEffort | undefined
): boolean {
  if (!option || effort === 'none') return false;
  if (option.thinkingAlwaysOn || option.controls?.effort) return true;
  return option.thinkingToggle === true && !thinkingSwitchedOff(setting, option);
}

/**
 * What a turn asks for, field by field: the conversation's override, else the model's default from
 * the Models screen, else the catalog's sampling for this thinking state. Filtered and clamped to
 * the model's controls by requestGeneration.
 */
export function turnGeneration(
  chat: GenerationSettings | undefined,
  defaults: ModelSettings | undefined,
  option: Pick<ChatModelOption, 'catalogSampling'> | undefined,
  thinking: boolean
): GenerationSettings {
  return layeredGeneration({
    chat,
    model: defaults?.generation,
    catalog: catalogSeed(option?.catalogSampling, thinking),
  });
}

/**
 * The sampling a title, suggestion or compaction sends: the model's defaults and the catalog's
 * non-thinking sampling, since those run with thinking off. Never the conversation's overrides, and
 * never an output size or budget, which each sets for itself.
 */
export function auxiliaryGeneration(
  defaults: ModelSettings | undefined,
  option: Pick<ChatModelOption, 'catalogSampling' | 'controls'> | undefined
): Omit<GenerationSettings, 'maxOutputTokens' | 'thinkingBudgetTokens'> {
  const {
    maxOutputTokens: _output,
    thinkingBudgetTokens: _budget,
    ...sampling
  } = requestGeneration(turnGeneration(undefined, defaults, option, false), option?.controls);
  return sampling;
}
