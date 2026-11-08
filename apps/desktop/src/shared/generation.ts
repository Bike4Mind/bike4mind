/**
 * Per-request generation settings and the controls that say which a model takes.
 *
 * Main builds a `ModelControls` for every listed model (OllamaLocal, OpenAICompatibleChat and the
 * hosted catalog in ModelCatalog), so backend rules stay in main and the renderer draws only what
 * a model's controls list.
 */

import {
  GENERATION_FIELDS,
  GENERATION_INTEGER_FIELDS,
  withinGenerationBounds,
  type GenerationField,
  type GenerationSettings,
} from '@bike4mind/local-models/model-settings';
import type { ReasoningEffortSetting } from './chat';

export {
  effortSent,
  GENERATION_BOUNDS,
  GENERATION_FIELDS,
  parseGenerationInput,
  type GenerationField,
  type GenerationSettings,
} from '@bike4mind/local-models/model-settings';

export const GENERATION_LABELS: Readonly<Record<GenerationField, string>> = {
  temperature: 'Temperature',
  topP: 'Top P',
  topK: 'Top K',
  minP: 'Min P',
  repeatPenalty: 'Repeat penalty',
  presencePenalty: 'Presence penalty',
  maxOutputTokens: 'Max output tokens',
  thinkingBudgetTokens: 'Thinking budget',
};

/**
 * 'request' takes effect on the next turn. 'load' reloads the model when it changes, so it is
 * set per model and never per conversation.
 */
export type ControlScope = 'request' | 'load';

export interface NumericControl {
  min: number;
  max: number;
  /** The number input's step; a value is never rounded to it. */
  step: number;
  /** What the model runs with while the setting is untouched; absent when Desktop cannot know it. */
  default?: number;
  /** The model's own default when it was above `max` and `default` was clamped, so a later `max` can re-derive it. */
  unclampedDefault?: number;
  /** Max output with no default because, untouched, a reply runs until the model stops or the context is full. */
  unlimitedDefault?: true;
  /** Shown at `value` and not editable. Nothing is sent for a locked control. */
  locked?: { value: number; reason: string };
  /**
   * Max output on a model that thinks with a budget: the server raises max_tokens to the budget plus
   * this many tokens, so the floor follows the budget the turn sends; see effectiveControls.
   */
  budgetHeadroom?: number;
  /** Max output that the model's thinking is spent from, so a low limit can leave no room for the answer. */
  includesThinking?: true;
  /** The backend's own default does not fit this model, so a turn sends `default` while the setting is untouched. */
  sendsDefault?: true;
  scope: ControlScope;
}

export interface EffortControl {
  /** The settings besides `default` this model acts on, lowest first. */
  levels: ReasoningEffortSetting[];
  scope: 'request';
}

/** What a model and the backend serving it accept. An option that is not listed is not drawn or sent. */
export type ModelControls = { [Field in GenerationField]?: NumericControl } & { effort?: EffortControl };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

/** The known in-bounds fields of a stored session's value, or undefined when none are. */
export function normalizeGeneration(raw: unknown): GenerationSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const settings: GenerationSettings = {};
  for (const field of GENERATION_FIELDS) {
    const value = raw[field];
    if (withinGenerationBounds(field, value)) settings[field] = value;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function sentValue(field: GenerationField, value: unknown, control: NumericControl | undefined): number | undefined {
  if (!isFiniteNumber(value) || !control || control.locked || control.scope !== 'request') return undefined;
  const clamped = Math.min(control.max, Math.max(control.min, value));
  return GENERATION_INTEGER_FIELDS.has(field) ? Math.round(clamped) : clamped;
}

/** The controls as they stand for these settings: a budget-thinking model's max output floor follows its budget. */
export function effectiveControls(
  controls: ModelControls | undefined,
  settings: GenerationSettings | undefined
): ModelControls | undefined {
  const output = controls?.maxOutputTokens;
  const budget = controls?.thinkingBudgetTokens;
  if (!controls || !output?.budgetHeadroom || !budget) return controls;
  const sentBudget =
    sentValue('thinkingBudgetTokens', settings?.thinkingBudgetTokens, budget) ?? budget.default ?? budget.min;
  const min = Math.min(output.max, Math.max(output.min, sentBudget + output.budgetHeadroom));
  return { ...controls, maxOutputTokens: { ...output, min } };
}

/**
 * What one request for a model carries: only request-scope fields its controls list and do not
 * lock, clamped into range, integers where the backend wants one, plus any `sendsDefault` default
 * for a field left untouched. Empty when nothing applies.
 */
export function requestGeneration(
  settings: GenerationSettings | undefined,
  controls: ModelControls | undefined
): GenerationSettings {
  const sent: GenerationSettings = {};
  const effective = effectiveControls(controls, settings);
  if (!effective) return sent;
  for (const field of GENERATION_FIELDS) {
    const control = effective[field];
    const value = sentValue(field, settings?.[field] ?? (control?.sendsDefault ? control.default : undefined), control);
    if (value !== undefined) sent[field] = value;
  }
  return sent;
}

/**
 * The curated catalog's family sampling for a reviewed build (`families.*.sampling` in
 * b4m-core/common modelHub.ts), by whether the turn thinks. Main reads it; see LocalModels.
 */
export interface CatalogSampling {
  thinking?: GenerationSettings;
  nonThinking?: GenerationSettings;
}

/** The catalog's sampling for a turn that thinks or does not; never the other state's, which is tuned for it. */
export function catalogSeed(sampling: CatalogSampling | undefined, thinking: boolean): GenerationSettings | undefined {
  return thinking ? sampling?.thinking : sampling?.nonThinking;
}

/** Where a value a turn sends comes from, highest first. */
export type GenerationSource = 'chat' | 'model' | 'catalog';

export type GenerationLayers = Partial<Record<GenerationSource, GenerationSettings>>;

const LAYER_ORDER: readonly GenerationSource[] = ['chat', 'model', 'catalog'];

/**
 * Each field from the highest layer that sets it: the conversation's override, the model's default
 * from the Models screen, then the catalog. A field none sets is left to the model's own default.
 */
export function layeredGeneration(layers: GenerationLayers): GenerationSettings {
  const settings: GenerationSettings = {};
  for (const field of GENERATION_FIELDS) {
    const value = LAYER_ORDER.map(source => layers[source]?.[field]).find(isFiniteNumber);
    if (value !== undefined) settings[field] = value;
  }
  return settings;
}
