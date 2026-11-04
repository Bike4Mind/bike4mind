/**
 * Per-model defaults set on the Models screen, stored in userData/model-settings.json by chat model
 * id (main/chat/ModelSettingsStore.ts). Device-side models only: a hosted model's defaults are the
 * server catalog's.
 */

import { parseLocalModelId, REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from './chat';
import { normalizeGeneration, parseGenerationInput, type GenerationSettings } from './generation';
import { parseModelContextSetting, type LocalContextSize, type ModelContextSetting } from './localContextSetting';

export type ModelEffort = Exclude<ReasoningEffortSetting, 'default'>;

/** Ollama's draft_num_predict ceiling, the range the catalog allows (b4m-core/common/src/schemas/modelHub.ts). */
export const MAX_DRAFT_TOKENS = 16;

/** How long Ollama keeps the model loaded after a request, in seconds; -1 keeps it until Ollama stops. */
export const KEEP_ALIVE_CHOICES = [300, 1800, 3600, 14400, -1] as const;
export type KeepAliveSeconds = (typeof KEEP_ALIVE_CHOICES)[number];

export interface ModelSettings {
  /** Below a conversation's overrides and above the catalog's sampling; see layeredGeneration. */
  generation?: GenerationSettings;
  /** Sent while the conversation's effort is `default`, on a model whose controls list effort levels. */
  effort?: ModelEffort;
  /** The rest are load-time, set per model only and sent on every request for it. Absent: nothing sent. */
  context?: ModelContextSetting;
  /** Ollama `draft_num_predict` for a model with an MTP or draft layer; 0 turns speculation off. */
  draftTokens?: number;
  /** Ollama `keep_alive`. */
  keepAlive?: KeepAliveSeconds;
}

export type ModelLoadSettings = Pick<ModelSettings, 'context' | 'draftTokens' | 'keepAlive'>;

/** One context size the dialog offers, rated for this model. */
export interface ContextSizeOffer {
  size: LocalContextSize;
  /** The num_ctx a fixed `size` sends: the size, or the trained length when that is less. */
  tokens: number;
  /** What Auto sends with `size` as its cap. */
  autoTokens: number;
  /** Whether the model loads at `tokens` (main/chat/localContext.ts loadsInMemory); absent when unmeasured. */
  loads?: boolean;
}

/** The load-time options a model and its server take; main builds it per backend and the dialog draws only these. */
export interface ModelLoadOffer {
  context?:
    | {
        kind: 'ollama';
        /** What the model runs at while it follows the Settings choice. */
        settings: number;
        /** What Auto picks for it with no cap; Auto is offered only when Desktop can measure the model. */
        auto?: number;
        sizes: ContextSizeOffer[];
      }
    /** A context the server fixes: a smaller size here is a client budget that compacts sooner, never a reload. */
    | { kind: 'budget'; server: number; sizes: LocalContextSize[] };
  /** For a model with an MTP or draft layer: the draft count Ollama runs it with when none is set. */
  draft?: { modelDefault: number; max: number };
  keepAlive?: true;
}

const MAX_ID_LENGTH = 1024;

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function isModelEffort(value: unknown): value is ModelEffort {
  return value !== 'default' && REASONING_EFFORT_SETTINGS.some(setting => setting === value);
}

export function isDraftTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DRAFT_TOKENS;
}

function isKeepAlive(value: unknown): value is KeepAliveSeconds {
  return KEEP_ALIVE_CHOICES.some(choice => choice === value);
}

export function isModelSettingsId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && parseLocalModelId(id) !== null;
}

/** True when a set holds no default at all, which the store keeps as no entry. */
export function isEmptyModelSettings(settings: ModelSettings): boolean {
  return Object.values(settings).every(value => value === undefined);
}

/** What a stored entry still holds that is valid; undefined when nothing is. */
export function normalizeModelSettings(raw: unknown): ModelSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const generation = normalizeGeneration(raw.generation);
  const context = parseModelContextSetting(raw.context);
  const settings: ModelSettings = {
    ...(generation ? { generation } : {}),
    ...(isModelEffort(raw.effort) ? { effort: raw.effort } : {}),
    ...(context ? { context } : {}),
    ...(isDraftTokens(raw.draftTokens) ? { draftTokens: raw.draftTokens } : {}),
    ...(isKeepAlive(raw.keepAlive) ? { keepAlive: raw.keepAlive } : {}),
  };
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * A replacement set from the renderer, or null when it is not one: a malformed known field rejects
 * the whole set, as does one with keys but no known field, so a bad call never clears what is
 * stored. `{}` clears the model's defaults.
 */
export function parseModelSettingsInput(raw: unknown): ModelSettings | null {
  if (!isRecord(raw)) return null;
  const settings: ModelSettings = {};
  let known = false;
  if (raw.generation !== undefined) {
    const generation = parseGenerationInput(raw.generation);
    if (!generation) return null;
    known = true;
    if (Object.keys(generation).length > 0) settings.generation = generation;
  }
  if (raw.effort !== undefined) {
    if (!isModelEffort(raw.effort)) return null;
    known = true;
    settings.effort = raw.effort;
  }
  if (raw.context !== undefined) {
    const context = parseModelContextSetting(raw.context);
    if (!context) return null;
    known = true;
    settings.context = context;
  }
  if (raw.draftTokens !== undefined) {
    if (!isDraftTokens(raw.draftTokens)) return null;
    known = true;
    settings.draftTokens = raw.draftTokens;
  }
  if (raw.keepAlive !== undefined) {
    if (!isKeepAlive(raw.keepAlive)) return null;
    known = true;
    settings.keepAlive = raw.keepAlive;
  }
  return !known && Object.keys(raw).length > 0 ? null : settings;
}

/** The file's entries that are still valid, invalid ones dropped; null when it is not a settings file at all. */
export function parseModelSettingsFile(raw: unknown): Map<string, ModelSettings> | null {
  if (!isRecord(raw) || !isRecord(raw.models)) return null;
  const parsed = new Map<string, ModelSettings>();
  for (const [id, entry] of Object.entries(raw.models)) {
    const settings = isModelSettingsId(id) ? normalizeModelSettings(entry) : undefined;
    if (settings) parsed.set(id, settings);
  }
  return parsed;
}
