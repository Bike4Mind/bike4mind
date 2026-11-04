/**
 * Per-request generation settings and the controls that say which a model takes.
 *
 * Main builds a `ModelControls` for every listed model (OllamaLocal, OpenAICompatibleChat and the
 * hosted catalog in ModelCatalog), so backend rules stay in main and the renderer draws only what
 * a model's controls list.
 */

import { REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from './chat';

/**
 * A conversation's overrides. An absent field sends nothing, so the model's own default applies.
 * Stored on the session as `generation`; see SessionStore.
 */
export interface GenerationSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  /** Replaces the model's own output ceiling for this conversation's turns. */
  maxOutputTokens?: number;
  /** Thinking budget for a Claude model that thinks with a fixed budget rather than an effort. */
  thinkingBudgetTokens?: number;
}

export type GenerationField = keyof GenerationSettings;

/** In the order the composer lists them. */
export const GENERATION_FIELDS: readonly GenerationField[] = [
  'temperature',
  'topP',
  'topK',
  'minP',
  'repeatPenalty',
  'presencePenalty',
  'maxOutputTokens',
  'thinkingBudgetTokens',
];

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

const INTEGER_FIELDS: ReadonlySet<GenerationField> = new Set(['topK', 'maxOutputTokens', 'thinkingBudgetTokens']);

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

/**
 * The level a turn sends for a stored setting: the setting when `levels` lists it, else the listed
 * level nearest it, the lower on a tie, so a level the model stops listing still moves effort the
 * way it was set. Only a stored `none` maps to `none`, since that level turns thinking off.
 */
export function effortSent(
  setting: ReasoningEffortSetting,
  levels: readonly ReasoningEffortSetting[]
): Exclude<ReasoningEffortSetting, 'default'> | undefined {
  if (setting === 'default') return undefined;
  if (levels.includes(setting)) return setting;
  const rank = (level: ReasoningEffortSetting) => REASONING_EFFORT_SETTINGS.indexOf(level);
  let nearest: Exclude<ReasoningEffortSetting, 'default'> | undefined;
  for (const level of levels) {
    if (level === 'default' || level === 'none') continue;
    if (nearest === undefined || Math.abs(rank(level) - rank(setting)) < Math.abs(rank(nearest) - rank(setting)))
      nearest = level;
  }
  return nearest;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The widest range each field takes on any model; a model's own control narrows it, and each
 * turn clamps to that (see requestGeneration). Must cover every range in main/chat/modelControls.
 */
export const GENERATION_BOUNDS: Readonly<Record<GenerationField, { min: number; max: number }>> = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  topK: { min: 0, max: 200 },
  minP: { min: 0, max: 1 },
  repeatPenalty: { min: 0.5, max: 2 },
  presencePenalty: { min: 0, max: 2 },
  maxOutputTokens: { min: 1, max: 2_000_000 },
  thinkingBudgetTokens: { min: 1024, max: 32_000 },
};

function withinBounds(field: GenerationField, value: unknown): value is number {
  const bounds = GENERATION_BOUNDS[field];
  return (
    isFiniteNumber(value) &&
    value >= bounds.min &&
    value <= bounds.max &&
    (!INTEGER_FIELDS.has(field) || Number.isInteger(value))
  );
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
    if (withinBounds(field, value)) settings[field] = value;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * A replacement set from the renderer, or null when it is not one: any known field out of bounds
 * or not a number rejects the whole set, and so does a set with keys but no known field holding a
 * value, so a malformed call never clears what is stored. Only `{}` clears every override.
 */
export function parseGenerationInput(raw: unknown): GenerationSettings | null {
  if (!isRecord(raw)) return null;
  const settings: GenerationSettings = {};
  for (const field of GENERATION_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!withinBounds(field, value)) return null;
    settings[field] = value;
  }
  return Object.keys(settings).length === 0 && Object.keys(raw).length > 0 ? null : settings;
}

function sentValue(field: GenerationField, value: unknown, control: NumericControl | undefined): number | undefined {
  if (!isFiniteNumber(value) || !control || control.locked || control.scope !== 'request') return undefined;
  const clamped = Math.min(control.max, Math.max(control.min, value));
  return INTEGER_FIELDS.has(field) ? Math.round(clamped) : clamped;
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
