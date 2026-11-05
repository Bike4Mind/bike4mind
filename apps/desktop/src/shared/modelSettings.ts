/**
 * Per-model defaults set on the Models screen, stored in userData/model-settings.json by chat model
 * id (main/chat/ModelSettingsStore.ts). Device-side models only: a hosted model's defaults are the
 * server catalog's.
 */

import { parseLocalModelId, REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from './chat';
import { GENERATION_FIELDS, normalizeGeneration, parseGenerationInput, type GenerationSettings } from './generation';
import { parseModelContextSetting, type LocalContextSize, type ModelContextSetting } from './localContextSetting';
import type { QuantizedKvCacheType } from './modelServers';

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
        /** The most a fixed size can send for this model; an Auto cap at or past it is the same as Auto. */
        ceiling?: number;
      }
    /** A context the server fixes: a smaller size here is a client budget that compacts sooner, never a reload. */
    | { kind: 'budget'; server: number; sizes: LocalContextSize[] };
  /** For a model with an MTP or draft layer: the draft count Ollama runs it with when none is set. */
  draft?: { modelDefault: number; max: number };
  keepAlive?: true;
  /** Ollama's KV cache type, set server-wide and never per model: the one entered in Settings, else f16. */
  kvCache?: { type: 'f16' | QuantizedKvCacheType };
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

const STORED_FIELDS: ReadonlySet<string> = new Set(['generation', 'effort', 'context', 'draftTokens', 'keepAlive']);
const GENERATION_FIELD_NAMES: ReadonlySet<string> = new Set(GENERATION_FIELDS);

/** The settings file as read: what Desktop uses, plus every entry and top-level key as written. */
export interface StoredModelSettings {
  settings: Map<string, ModelSettings>;
  /** Every entry by its key, including ones Desktop does not recognize, so a rewrite keeps them. */
  entries: Map<string, unknown>;
  /** The file's top-level keys besides `models`. */
  rest: Record<string, unknown>;
}

/** A recognized model whose entry, or one known field of it (`field`), holds a value Desktop cannot use. */
export interface InvalidModelSetting {
  modelId: string;
  field: string | null;
}

export function emptyStoredModelSettings(): StoredModelSettings {
  return { settings: new Map(), entries: new Map(), rest: {} };
}

/** One stored entry, read strictly: a known field with a bad value is named, unknown fields are left for the writer. */
function parseStoredEntry(raw: unknown): { settings: ModelSettings } | { field: string | null } {
  if (!isRecord(raw)) return { field: null };
  const settings: ModelSettings = {};
  if (raw.generation !== undefined) {
    const stored = raw.generation;
    if (!isRecord(stored)) return { field: 'generation' };
    for (const field of GENERATION_FIELDS) {
      if (Object.hasOwn(stored, field) && !parseGenerationInput({ [field]: stored[field] }))
        return { field: `generation.${field}` };
    }
    const generation = normalizeGeneration(stored);
    if (generation) settings.generation = generation;
  }
  if (raw.effort !== undefined) {
    if (!isModelEffort(raw.effort)) return { field: 'effort' };
    settings.effort = raw.effort;
  }
  if (raw.context !== undefined) {
    const context = parseModelContextSetting(raw.context);
    if (!context) return { field: 'context' };
    settings.context = context;
  }
  if (raw.draftTokens !== undefined) {
    if (!isDraftTokens(raw.draftTokens)) return { field: 'draftTokens' };
    settings.draftTokens = raw.draftTokens;
  }
  if (raw.keepAlive !== undefined) {
    if (!isKeepAlive(raw.keepAlive)) return { field: 'keepAlive' };
    settings.keepAlive = raw.keepAlive;
  }
  return { settings };
}

/**
 * The file's settings by model, or the first recognized model holding a bad known value; null when it
 * is not a settings file at all. Unknown fields and unrecognized keys are kept in `entries`, never read.
 */
export function parseModelSettingsFile(raw: unknown): StoredModelSettings | { invalid: InvalidModelSetting } | null {
  if (!isRecord(raw) || !isRecord(raw.models)) return null;
  const settings = new Map<string, ModelSettings>();
  const entries = new Map(Object.entries(raw.models));
  for (const [id, entry] of entries) {
    if (!isModelSettingsId(id)) continue;
    const parsed = parseStoredEntry(entry);
    if ('field' in parsed) return { invalid: { modelId: id, field: parsed.field } };
    if (!isEmptyModelSettings(parsed.settings)) settings.set(id, parsed.settings);
  }
  return { settings, entries, rest: Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'models')) };
}

/** The entry to write for `settings`, keeping what the stored entry held that Desktop does not know; undefined when nothing is left. */
export function storedModelEntry(previous: unknown, settings: ModelSettings): Record<string, unknown> | undefined {
  const stored = isRecord(previous) ? previous : {};
  const storedGeneration = isRecord(stored.generation) ? stored.generation : {};
  const generation = Object.fromEntries([
    ...Object.entries(storedGeneration).filter(([key]) => !GENERATION_FIELD_NAMES.has(key)),
    ...Object.entries(settings.generation ?? {}).filter(([, value]) => value !== undefined),
  ]);
  const entry = Object.fromEntries([
    ...Object.entries(stored).filter(([key]) => !STORED_FIELDS.has(key)),
    ...(Object.keys(generation).length > 0 ? [['generation', generation] as const] : []),
    ...Object.entries(settings).filter(([key, value]) => key !== 'generation' && value !== undefined),
  ]);
  return Object.keys(entry).length > 0 ? entry : undefined;
}
