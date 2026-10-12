import { ModelBackend, type ModelInfo } from '@bike4mind/common';

// Bedrock cross-region inference profiles prefix the foundation-model id with a geography.
const BEDROCK_PROFILE_PREFIX = /^(global|us-gov|us|eu|apac|jp|au|ca)\./;
const VERSION_SUFFIX = /-v\d+(:\d+)?$/;
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * Identity of the model behind an id, per route: `gpt-4.1-2025-04-14` and `gpt-4.1` share one, as
 * do a Bedrock foundation id and its `global.`/`us.` inference profiles. The backend stays in the
 * key, so a model served both direct and on Bedrock keeps one row per route.
 */
export function canonicalModelKey(model: Pick<ModelInfo, 'id' | 'backend'>): string {
  let id = String(model.id).toLowerCase();
  if (model.backend === ModelBackend.Bedrock) id = id.replace(BEDROCK_PROFILE_PREFIX, '');
  id = id.replace(VERSION_SUFFIX, '').replace(DATE_SUFFIX, '');
  return `${model.backend}:${id}`;
}

/** Lower sorts first. A profile beats a bare foundation id, which Bedrock rarely serves on demand. */
function routePreference(model: ModelInfo): number {
  const id = String(model.id);
  if (model.backend !== ModelBackend.Bedrock) return 0;
  if (id.startsWith('global.')) return 0;
  return BEDROCK_PROFILE_PREFIX.test(id) ? 1 : 2;
}

function preferenceTuple(model: ModelInfo, preferredIds: ReadonlySet<string>, activeModelId: string): number[] {
  const id = String(model.id);
  return [
    id === activeModelId ? 0 : 1,
    preferredIds.has(id) ? 0 : 1,
    routePreference(model),
    DATE_SUFFIX.test(id.replace(VERSION_SUFFIX, '')) ? 1 : 0,
  ];
}

function isPreferred(candidate: number[], incumbent: number[]): boolean {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== incumbent[i]) return candidate[i] < incumbent[i];
  }
  return false;
}

/**
 * One enabled row per canonical model, in input order. A disabled active model is also kept so
 * the user can see their current selection and switch to an enabled twin.
 *
 * `preferredIds` (Recommended and Favorites) win their group unless the active model is enabled.
 * Disabled favorites and recommendations are hidden like other unavailable models.
 */
export function dedupeModelsForPicker(
  models: ModelInfo[],
  preferredIds: ReadonlySet<string>,
  activeModelId: string
): ModelInfo[] {
  const winners = new Map<string, { model: ModelInfo; preference: number[] }>();
  for (const model of models) {
    if (model.disabled) continue;
    const key = canonicalModelKey(model);
    const preference = preferenceTuple(model, preferredIds, activeModelId);
    const incumbent = winners.get(key);
    if (!incumbent || isPreferred(preference, incumbent.preference)) winners.set(key, { model, preference });
  }

  const kept = new Set(Array.from(winners.values(), winner => winner.model));
  return models.filter(model => kept.has(model) || (model.disabled && String(model.id) === activeModelId));
}
