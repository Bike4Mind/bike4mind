/**
 * Per-request generation settings and the controls that say which a model takes.
 *
 * Main builds a `ModelControls` for every listed model (OllamaLocal, OpenAICompatibleChat and the
 * hosted catalog in ModelCatalog), so backend rules stay in main and the renderer draws only what
 * a model's controls list.
 */

import type { ReasoningEffortSetting } from './chat';

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
  'maxOutputTokens',
  'thinkingBudgetTokens',
];

const INTEGER_FIELDS: ReadonlySet<GenerationField> = new Set(['topK', 'maxOutputTokens', 'thinkingBudgetTokens']);

/**
 * 'request' takes effect on the next turn. 'load' reloads the model when it changes, so it is
 * set per model and never per conversation.
 */
export type ControlScope = 'request' | 'load';

export interface NumericControl {
  min: number;
  max: number;
  /** For the composer's slider; a value is never rounded to it. */
  step: number;
  /** What the model runs with while the setting is untouched; absent when Desktop cannot know it. */
  default?: number;
  /** Shown at `value` and not editable. Nothing is sent for a locked control. */
  locked?: { value: number; reason: string };
  /**
   * Max output on a model that thinks with a budget: the server raises max_tokens to the budget plus
   * this many tokens, so the floor follows the budget the turn sends; see effectiveControls.
   */
  budgetHeadroom?: number;
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

/**
 * The known fields of an untrusted value (a stored session, an IPC argument) that hold finite
 * numbers, or undefined when none do. Ranges are not checked here: they depend on the model,
 * which can change after the value is stored; see requestGeneration.
 */
export function normalizeGeneration(raw: unknown): GenerationSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const settings: GenerationSettings = {};
  for (const field of GENERATION_FIELDS) {
    const value = source[field];
    if (isFiniteNumber(value)) settings[field] = value;
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
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
 * lock, clamped into range, integers where the backend wants one. Empty when nothing applies.
 */
export function requestGeneration(
  settings: GenerationSettings | undefined,
  controls: ModelControls | undefined
): GenerationSettings {
  const sent: GenerationSettings = {};
  const effective = effectiveControls(controls, settings);
  if (!settings || !effective) return sent;
  for (const field of GENERATION_FIELDS) {
    const value = sentValue(field, settings[field], effective[field]);
    if (value !== undefined) sent[field] = value;
  }
  return sent;
}
