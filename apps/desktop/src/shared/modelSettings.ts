/**
 * Per-model defaults set on the Models screen, stored in userData/model-settings.json by chat model
 * id (main/chat/ModelSettingsStore.ts). Device-side models only: a hosted model's defaults are the
 * server catalog's.
 */

import { parseLocalModelId, REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from './chat';
import { GENERATION_FIELDS, parseGenerationInput, type GenerationField, type GenerationSettings } from './generation';
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

const CONTEXT_FIELDS: ReadonlySet<string> = new Set(['mode', 'tokens', 'maxTokens']);

/** A value as JSON for a message or a log line, cut to `max` characters. */
export function quotedForMessage(value: unknown, max = 120): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** A known field holding a value of the right type that this version does not support, such as a newer one's. */
export interface UnsupportedModelSetting {
  /** `effort`, `context`, `generation.topK`, ... */
  field: string;
  value: unknown;
}

/** The settings file as read: what Desktop uses, plus every entry and top-level key as written. */
export interface StoredModelSettings {
  settings: Map<string, ModelSettings>;
  /** By model: values kept in the file but treated as unset. */
  unsupported: Map<string, UnsupportedModelSetting[]>;
  /** Every entry by its key, including ones Desktop does not recognize, so a rewrite keeps them. */
  entries: Map<string, unknown>;
  /** The file's top-level keys besides `models`. */
  rest: Record<string, unknown>;
}

/** A recognized model whose entry, or one known field of it (`field`), is of the wrong type or broken. */
export interface InvalidModelSetting {
  modelId: string;
  field: string | null;
}

export function emptyStoredModelSettings(): StoredModelSettings {
  return { settings: new Map(), unsupported: new Map(), entries: new Map(), rest: {} };
}

/** A stored value: usable, of the right type but beyond this version, or of the wrong type. */
type StoredRead<T> = { value: T } | 'unsupported' | 'broken';
type StoredScalarField = 'effort' | 'context' | 'draftTokens' | 'keepAlive';

function readGenerationField(field: GenerationField, value: unknown): StoredRead<number> {
  if (typeof value !== 'number') return 'broken';
  const parsed = parseGenerationInput({ [field]: value })?.[field];
  return parsed === undefined ? 'unsupported' : { value: parsed };
}

function readStoredField(field: StoredScalarField, value: unknown): StoredRead<unknown> {
  switch (field) {
    case 'effort':
      if (typeof value !== 'string') return 'broken';
      return isModelEffort(value) ? { value } : 'unsupported';
    case 'draftTokens':
      if (typeof value !== 'number') return 'broken';
      return isDraftTokens(value) ? { value } : 'unsupported';
    case 'keepAlive':
      if (typeof value !== 'number') return 'broken';
      return isKeepAlive(value) ? { value } : 'unsupported';
    case 'context': {
      if (!isRecord(value) || typeof value.mode !== 'string') return 'broken';
      if (value.mode === 'fixed' && typeof value.tokens !== 'number') return 'broken';
      if (value.mode === 'auto' && value.maxTokens !== undefined && typeof value.maxTokens !== 'number')
        return 'broken';
      const context = parseModelContextSetting(value);
      return context ? { value: context } : 'unsupported';
    }
  }
}

/** One stored entry: a known field of the wrong type is named; one beyond this version is listed and left unset. */
function parseStoredEntry(
  raw: unknown
): { settings: ModelSettings; unsupported: UnsupportedModelSetting[] } | { field: string | null } {
  if (!isRecord(raw)) return { field: null };
  const settings: ModelSettings = {};
  const unsupported: UnsupportedModelSetting[] = [];
  if (raw.generation !== undefined) {
    const stored = raw.generation;
    if (!isRecord(stored)) return { field: 'generation' };
    const generation: GenerationSettings = {};
    for (const field of GENERATION_FIELDS) {
      if (!Object.hasOwn(stored, field)) continue;
      const read = readGenerationField(field, stored[field]);
      if (read === 'broken') return { field: `generation.${field}` };
      if (read === 'unsupported') unsupported.push({ field: `generation.${field}`, value: stored[field] });
      else generation[field] = read.value;
    }
    if (Object.keys(generation).length > 0) settings.generation = generation;
  }
  for (const field of ['effort', 'context', 'draftTokens', 'keepAlive'] as const) {
    if (raw[field] === undefined) continue;
    const read = readStoredField(field, raw[field]);
    if (read === 'broken') return { field };
    if (read === 'unsupported') unsupported.push({ field, value: raw[field] });
    else Object.assign(settings, { [field]: read.value });
  }
  return { settings, unsupported };
}

/**
 * The file's settings by model, or the first recognized model holding a known field of the wrong type;
 * null when it is not a settings file at all. Unknown fields and unrecognized keys are kept in `entries`.
 */
export function parseModelSettingsFile(raw: unknown): StoredModelSettings | { invalid: InvalidModelSetting } | null {
  if (!isRecord(raw) || !isRecord(raw.models)) return null;
  const settings = new Map<string, ModelSettings>();
  const unsupported = new Map<string, UnsupportedModelSetting[]>();
  const entries = new Map(Object.entries(raw.models));
  for (const [id, entry] of entries) {
    if (!isModelSettingsId(id)) continue;
    const parsed = parseStoredEntry(entry);
    if ('field' in parsed) return { invalid: { modelId: id, field: parsed.field } };
    if (!isEmptyModelSettings(parsed.settings)) settings.set(id, parsed.settings);
    if (parsed.unsupported.length > 0) unsupported.set(id, parsed.unsupported);
  }
  const rest = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'models'));
  return { settings, unsupported, entries, rest };
}

/**
 * The entry to write for `settings`. What the stored entry held that this version does not know, or
 * holds beyond what it supports, stays as written unless `settings` sets that field. Undefined when empty.
 */
export function storedModelEntry(previous: unknown, settings: ModelSettings): Record<string, unknown> | undefined {
  const stored = isRecord(previous) ? previous : {};
  const storedGeneration = isRecord(stored.generation) ? stored.generation : {};
  const keptGeneration = Object.entries(storedGeneration).filter(([key, value]) => {
    if (!GENERATION_FIELD_NAMES.has(key)) return true;
    const field = key as GenerationField;
    return settings.generation?.[field] === undefined && readGenerationField(field, value) === 'unsupported';
  });
  const generation = Object.fromEntries([
    ...keptGeneration,
    ...Object.entries(settings.generation ?? {}).filter(([, value]) => value !== undefined),
  ]);
  const kept = (field: StoredScalarField): unknown =>
    stored[field] !== undefined && readStoredField(field, stored[field]) === 'unsupported' ? stored[field] : undefined;
  const storedContextExtras = isRecord(stored.context)
    ? Object.fromEntries(Object.entries(stored.context).filter(([key]) => !CONTEXT_FIELDS.has(key)))
    : {};
  const known: [string, unknown][] = [
    ['generation', Object.keys(generation).length > 0 ? generation : undefined],
    ['effort', settings.effort ?? kept('effort')],
    ['context', settings.context ? { ...storedContextExtras, ...settings.context } : kept('context')],
    ['draftTokens', settings.draftTokens ?? kept('draftTokens')],
    ['keepAlive', settings.keepAlive ?? kept('keepAlive')],
  ];
  const entry = Object.fromEntries([
    ...Object.entries(stored).filter(([key]) => !STORED_FIELDS.has(key)),
    ...known.filter(([, value]) => value !== undefined),
  ]);
  return Object.keys(entry).length > 0 ? entry : undefined;
}
