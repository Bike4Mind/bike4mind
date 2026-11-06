/** Model ids, effort levels, sampling fields and context choices shared by Desktop and the CLI; Node-free. */

export function localModelId(runtimeId: string, model: string): string {
  return `local:${encodeURIComponent(runtimeId)}:${model}`;
}

/** `local:<encoded runtime>:<model>`; runtime ids can contain colons so they are URL-encoded, the model stays raw. */
export function parseLocalModelId(id: string): { runtimeId: string; model: string } | null {
  const match = /^local:([^:]+):(.+)$/s.exec(id);
  if (!match) return null;
  try {
    return { runtimeId: decodeURIComponent(match[1]), model: match[2] };
  } catch {
    return null;
  }
}

/** Desktop's runtime id for the Ollama daemon on this computer, as in `local:ollama:<model>`. */
export const LOCAL_OLLAMA_RUNTIME_ID = 'ollama';

/**
 * How hard a model that reasons thinks before answering.
 *
 * `default` sends nothing and leaves the provider at its own effort, which is what every
 * conversation did before the setting existed. It is a real choice in the picker rather than
 * an empty state, because "let the provider decide" is a different instruction from "low".
 */
export type ReasoningEffortSetting = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Ascending, which is the order the picker lists them in. */
export const REASONING_EFFORT_SETTINGS: readonly ReasoningEffortSetting[] = [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

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

/**
 * A conversation's overrides. An absent field sends nothing, so the model's own default applies.
 * Stored on a Desktop session as `generation`; see SessionStore.
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

export const GENERATION_INTEGER_FIELDS: ReadonlySet<GenerationField> = new Set([
  'topK',
  'maxOutputTokens',
  'thinkingBudgetTokens',
]);

/**
 * The widest range each field takes on any model; a model's own control narrows it, and each
 * turn clamps to that. Must cover every range in Desktop's main/chat/modelControls.
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

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

/** A finite number inside the field's bounds, whole where the field takes integers. */
export function withinGenerationBounds(field: GenerationField, value: unknown): value is number {
  const bounds = GENERATION_BOUNDS[field];
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= bounds.min &&
    value <= bounds.max &&
    (!GENERATION_INTEGER_FIELDS.has(field) || Number.isInteger(value))
  );
}

/**
 * A replacement set, or null when it is not one: any known field out of bounds or not a number
 * rejects the whole set, and so does a set with keys but no known field holding a value, so a
 * malformed call never clears what is stored. Only `{}` clears every override.
 */
export function parseGenerationInput(raw: unknown): GenerationSettings | null {
  if (!isRecord(raw)) return null;
  const settings: GenerationSettings = {};
  for (const field of GENERATION_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!withinGenerationBounds(field, value)) return null;
    settings[field] = value;
  }
  return Object.keys(settings).length === 0 && Object.keys(raw).length > 0 ? null : settings;
}

/** The context sizes Desktop's Settings offers for local models; Desktop's own instructions alone run past 8K. */
export const LOCAL_CONTEXT_SIZES = [16384, 32768, 65536, 131072, 262144] as const;
export type LocalContextSize = (typeof LOCAL_CONTEXT_SIZES)[number];

/** One model's own choice from the Models screen, in place of the Settings one: Auto up to a cap, or one size. */
export type ModelContextSetting = { mode: 'auto'; maxTokens?: number } | { mode: 'fixed'; tokens: number };

const MIN_MODEL_CONTEXT_TOKENS = 512;

// A model's trained length can fall between or below the offered sizes, so any whole number up to the top size is kept.
function isContextTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MODEL_CONTEXT_TOKENS &&
    value <= LOCAL_CONTEXT_SIZES[LOCAL_CONTEXT_SIZES.length - 1]
  );
}

/** Null when `value` is not one; a cap or size outside 512 to the top offered size is not one either. */
export function parseModelContextSetting(value: unknown): ModelContextSetting | null {
  if (!isRecord(value)) return null;
  const { mode, tokens, maxTokens } = value;
  if (mode === 'fixed') return isContextTokens(tokens) ? { mode, tokens } : null;
  if (mode !== 'auto') return null;
  if (maxTokens === undefined) return { mode };
  return isContextTokens(maxTokens) ? { mode, maxTokens } : null;
}
