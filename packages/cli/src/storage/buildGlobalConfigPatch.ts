import type { CliConfig, GlobalConfigPatch } from './types';

/**
 * Compute the minimal global-config patch for a /config editor save: only the
 * editor-owned fields (defaultModel, preferences, features) that the user
 * actually changed vs the current effective (merged) config. Unchanged fields
 * are omitted, so a repo-injected value the user never touched is never
 * laundered into the global layer by a save() that spreads the merged config.
 *
 * defaultModel and preferences diff per key. features stays whole-object when
 * anything changed, on purpose: ConfigStore.save() feeds config.features to
 * mergeFeatures as the caller's COMPLETE desired set (absence of a key means
 * "removed"), so a per-key diff would make save() delete untouched keys. That
 * whole-object features path is only latently launderable today (no repo layer
 * populates features); tightening it needs a coordinated change to save()'s
 * concurrent-writer merge and is tracked separately.
 */
export function buildGlobalConfigPatch(prev: CliConfig | undefined, next: CliConfig): GlobalConfigPatch {
  const patch: GlobalConfigPatch = {};

  if (next.defaultModel !== prev?.defaultModel) {
    patch.defaultModel = next.defaultModel;
  }

  const changedPreferences: Partial<CliConfig['preferences']> = {};
  for (const [key, value] of Object.entries(next.preferences)) {
    const prevValue = (prev?.preferences as Record<string, unknown> | undefined)?.[key];
    if (JSON.stringify(value) !== JSON.stringify(prevValue)) {
      (changedPreferences as Record<string, unknown>)[key] = value;
    }
  }
  if (Object.keys(changedPreferences).length > 0) {
    patch.preferences = changedPreferences;
  }

  if (JSON.stringify(next.features ?? {}) !== JSON.stringify(prev?.features ?? {})) {
    patch.features = next.features;
  }

  return patch;
}
