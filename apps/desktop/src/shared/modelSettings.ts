/**
 * Per-model defaults set on the Models screen, stored in userData/model-settings.json by chat model
 * id (main/chat/ModelSettingsStore.ts). Device-side models only: a hosted model's defaults are the
 * server catalog's.
 */

import { parseLocalModelId, REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from './chat';
import { normalizeGeneration, parseGenerationInput, type GenerationSettings } from './generation';

export type ModelEffort = Exclude<ReasoningEffortSetting, 'default'>;

/** Per-request options only; load-time ones (context, draft, keep_alive) get keys of their own beside these. */
export interface ModelSettings {
  /** Below a conversation's overrides and above the catalog's sampling; see layeredGeneration. */
  generation?: GenerationSettings;
  /** Sent while the conversation's effort is `default`, on a model whose controls list effort levels. */
  effort?: ModelEffort;
}

const MAX_ID_LENGTH = 1024;

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function isModelEffort(value: unknown): value is ModelEffort {
  return value !== 'default' && REASONING_EFFORT_SETTINGS.some(setting => setting === value);
}

export function isModelSettingsId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && parseLocalModelId(id) !== null;
}

/** What a stored entry still holds that is valid; undefined when nothing is. */
export function normalizeModelSettings(raw: unknown): ModelSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const generation = normalizeGeneration(raw.generation);
  const settings: ModelSettings = {
    ...(generation ? { generation } : {}),
    ...(isModelEffort(raw.effort) ? { effort: raw.effort } : {}),
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
