/**
 * Per-model defaults set on Desktop's Models screen, stored in its userData/model-settings.json by chat
 * model id. Desktop reads and writes the file (apps/desktop main/chat/ModelSettingsStore.ts); the CLI only
 * reads it. Device-side models only: a hosted model's defaults are the server catalog's.
 */

import {
  GENERATION_FIELDS,
  parseGenerationInput,
  parseLocalModelId,
  parseModelContextSetting,
  REASONING_EFFORT_SETTINGS,
  type GenerationField,
  type GenerationSettings,
  type ModelContextSetting,
  type ReasoningEffortSetting,
} from './fields';

export const MODEL_SETTINGS_FILE_NAME = 'model-settings.json';

export type ModelEffort = Exclude<ReasoningEffortSetting, 'default'>;

/** Ollama's draft_num_predict ceiling, the range the catalog allows (b4m-core/common/src/schemas/modelHub.ts). */
export const MAX_DRAFT_TOKENS = 16;

/** How long Ollama keeps the model loaded after a request, in seconds; -1 keeps it until Ollama stops. */
export const KEEP_ALIVE_CHOICES = [300, 1800, 3600, 14400, -1] as const;
export type KeepAliveSeconds = (typeof KEEP_ALIVE_CHOICES)[number];

export interface ModelSettings {
  /** Below a conversation's overrides and above the catalog's sampling; see Desktop's layeredGeneration. */
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

/** The settings file as read: what is used, plus every entry and top-level key as written. */
export interface StoredModelSettings {
  settings: Map<string, ModelSettings>;
  /** By model: values kept in the file but treated as unset. */
  unsupported: Map<string, UnsupportedModelSetting[]>;
  /**
   * By model: the known field of the wrong type or broken (`generation.temperature`, ...), or null when
   * the entry itself is not a set of settings. Only that model's reads and saves fail.
   */
  invalid: Map<string, string | null>;
  /** Every entry by its key, including ones this version does not recognize, so a rewrite keeps them. */
  entries: Map<string, unknown>;
  /** The file's top-level keys besides `models`. */
  rest: Record<string, unknown>;
}

export function emptyStoredModelSettings(): StoredModelSettings {
  return { settings: new Map(), unsupported: new Map(), invalid: new Map(), entries: new Map(), rest: {} };
}

/** A number JSON can hold; a hand-edited 1e999 parses to Infinity, which would be written back as null. */
function isStorableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A stored value: usable, of the right type but beyond this version, or of the wrong type. */
type StoredRead<T> = { value: T } | 'unsupported' | 'broken';
type StoredScalarField = 'effort' | 'context' | 'draftTokens' | 'keepAlive';

function readGenerationField(field: GenerationField, value: unknown): StoredRead<number> {
  if (!isStorableNumber(value)) return 'broken';
  const parsed = parseGenerationInput({ [field]: value })?.[field];
  return parsed === undefined ? 'unsupported' : { value: parsed };
}

function readStoredField(field: StoredScalarField, value: unknown): StoredRead<unknown> {
  switch (field) {
    case 'effort':
      if (typeof value !== 'string') return 'broken';
      return isModelEffort(value) ? { value } : 'unsupported';
    case 'draftTokens':
      if (!isStorableNumber(value)) return 'broken';
      return isDraftTokens(value) ? { value } : 'unsupported';
    case 'keepAlive':
      if (!isStorableNumber(value)) return 'broken';
      return isKeepAlive(value) ? { value } : 'unsupported';
    case 'context': {
      if (!isRecord(value) || typeof value.mode !== 'string') return 'broken';
      if (value.mode === 'fixed' || value.mode === 'auto') {
        const sizes = [value.tokens, value.maxTokens];
        if (sizes.some(size => size !== undefined && !isStorableNumber(size))) return 'broken';
        if (value.mode === 'fixed' && value.tokens === undefined) return 'broken';
      }
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
 * The file's settings by model, with each recognized model holding a known field of the wrong type in
 * `invalid`; null when it is not a settings file at all. Unknown fields and unrecognized keys are kept in `entries`.
 */
export function parseModelSettingsFile(raw: unknown): StoredModelSettings | null {
  if (!isRecord(raw) || !isRecord(raw.models)) return null;
  const stored = emptyStoredModelSettings();
  stored.entries = new Map(Object.entries(raw.models));
  for (const [id, entry] of stored.entries) {
    if (!isModelSettingsId(id)) continue;
    const parsed = parseStoredEntry(entry);
    if ('field' in parsed) {
      stored.invalid.set(id, parsed.field);
      continue;
    }
    if (!isEmptyModelSettings(parsed.settings)) stored.settings.set(id, parsed.settings);
    if (parsed.unsupported.length > 0) stored.unsupported.set(id, parsed.unsupported);
  }
  stored.rest = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'models'));
  return stored;
}

/**
 * The keys down to the first place `written`, `value` after a JSON round trip, no longer holds it, such
 * as a number too large that became null; null when it holds all of it.
 */
export function changedJsonPath(value: unknown, written: unknown): string[] | null {
  if (Array.isArray(value) || isRecord(value)) {
    if (!(Array.isArray(value) ? Array.isArray(written) : isRecord(written))) return [];
    const from = value as Record<string, unknown>;
    const to = written as Record<string, unknown>;
    const keys = Object.keys(from);
    if (keys.length !== Object.keys(to).length) return [];
    for (const key of keys) {
      if (!Object.hasOwn(to, key)) return [key];
      const below = changedJsonPath(from[key], to[key]);
      if (below) return [key, ...below];
    }
    return null;
  }
  return value === written ? null : [];
}

function contextKey(setting: ModelContextSetting): string {
  return setting.mode === 'fixed' ? `fixed:${setting.tokens}` : `auto:${setting.maxTokens ?? ''}`;
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
  const storedContext = readStoredField('context', stored.context);
  const usableContext = typeof storedContext === 'object' ? (storedContext.value as ModelContextSetting) : null;
  // A context this version cannot use may give its extra keys a meaning under its own mode, so they go with it.
  const storedContextExtras =
    isRecord(stored.context) && usableContext
      ? Object.fromEntries(Object.entries(stored.context).filter(([key]) => !CONTEXT_FIELDS.has(key)))
      : {};
  // The context as read again keeps what the stored one held beyond its mode, such as a maxTokens under fixed.
  const context = (setting: ModelContextSetting): unknown =>
    usableContext && contextKey(setting) === contextKey(usableContext)
      ? stored.context
      : { ...storedContextExtras, ...setting };
  const known: [string, unknown][] = [
    ['generation', Object.keys(generation).length > 0 ? generation : undefined],
    ['effort', settings.effort ?? kept('effort')],
    ['context', settings.context ? context(settings.context) : kept('context')],
    ['draftTokens', settings.draftTokens ?? kept('draftTokens')],
    ['keepAlive', settings.keepAlive ?? kept('keepAlive')],
  ];
  const entry = Object.fromEntries([
    ...Object.entries(stored).filter(([key]) => !STORED_FIELDS.has(key)),
    ...known.filter(([, value]) => value !== undefined),
  ]);
  return Object.keys(entry).length > 0 ? entry : undefined;
}
