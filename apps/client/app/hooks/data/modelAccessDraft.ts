import { z } from 'zod';
import type {
  LLMModelConfig,
  ModelAccessChange,
  ModelAccessEntry,
  ModelAccessSaveRequest,
  ModelAccessSaveResult,
} from '@bike4mind/common';

const ConfigurationSchema = z.object({
  id: z.string().min(1),
  enabled: z
    .boolean()
    .optional()
    .transform(value => value === true),
  allowedUserTags: z.array(z.string()).default([]),
  allowedEntitlements: z.array(z.string()).optional(),
  fallbackModel: z.string().optional(),
  rank: z.number().optional(),
  updatedAt: z.iso.datetime().nullable().optional(),
});
export const ModelConfigurationsResponseSchema = z.object({ settingValue: z.array(ConfigurationSchema) });
const AccessEntrySchema = ConfigurationSchema.extend({
  enabled: z.boolean(),
  allowedUserTags: z.array(z.string()),
  allowedEntitlements: z.array(z.string()),
  updatedAt: z.iso.datetime().nullable(),
});
export const ModelAccessSaveResultSchema = z.object({
  entries: z.array(z.object({ id: z.string(), entry: AccessEntrySchema.nullable() })),
  changed: z.number().int().nonnegative(),
  revision: z.string().nullable(),
});
export type SavedModelConfiguration = z.infer<typeof ConfigurationSchema>;
export type ModelConfigurationsRead = { configurations: SavedModelConfiguration[]; revision: string | null };
export type LoadedModelConfiguration = LLMModelConfig & { accessEntry: ModelAccessEntry | null };

export const loadedAccessEntry = (entry: SavedModelConfiguration): ModelAccessEntry => ({
  ...entry,
  allowedEntitlements: entry.allowedEntitlements ?? [],
  updatedAt: entry.updatedAt ?? null,
});

const sameMembers = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Diff against what the editor loaded, never stamps fetched immediately before Save. */
export function modelAccessChanges(
  current: readonly LoadedModelConfiguration[],
  baseline: readonly LoadedModelConfiguration[]
): ModelAccessSaveRequest['changes'] {
  const loaded = new Map(baseline.map(model => [model.id, model]));
  return current.flatMap(model => {
    const before = loaded.get(model.id);
    if (!before || before.accessEntry === undefined) throw new Error('Reload the model editor before saving.');
    const change: ModelAccessChange = {};
    if (model.enabled !== before.enabled) change.enabled = model.enabled;
    if (!sameMembers(model.allowedUserTags, before.allowedUserTags)) change.allowedUserTags = model.allowedUserTags;
    if (!sameMembers(model.allowedEntitlements, before.allowedEntitlements))
      change.allowedEntitlements = model.allowedEntitlements ?? [];
    if ((model.fallbackModel ?? '') !== (before.fallbackModel ?? ''))
      change.fallbackModel = model.fallbackModel || null;
    if (model.rank !== before.rank) change.rank = model.rank ?? null;
    if (Object.keys(change).length === 0) return [];
    // An absent entry starts from the catalog's displayed defaults, including a disabled/private model.
    const next =
      before.accessEntry === null
        ? {
            enabled: model.enabled,
            allowedUserTags: model.allowedUserTags,
            allowedEntitlements: model.allowedEntitlements ?? [],
            fallbackModel: model.fallbackModel || null,
            rank: model.rank ?? null,
          }
        : change;
    return [{ id: model.id, change: next, expectedUpdatedAt: before.accessEntry?.updatedAt ?? null }];
  });
}

/** Normalize the sent snapshot to the server's committed fields/stamps. */
export function committedModelSnapshot(
  sent: readonly LoadedModelConfiguration[],
  result: ModelAccessSaveResult
): LoadedModelConfiguration[] {
  const entries = new Map(result.entries.map(item => [item.id, item.entry]));
  return sent.map(model => {
    if (!entries.has(model.id)) return model;
    const entry = entries.get(model.id) ?? null;
    if (!entry) return { ...model, accessEntry: null };
    return {
      ...model,
      enabled: entry.enabled,
      allowedUserTags: entry.allowedUserTags,
      allowedEntitlements: entry.allowedEntitlements,
      fallbackModel: entry.fallbackModel ?? '',
      rank: entry.rank,
      accessEntry: entry,
    };
  });
}

/** A late success acknowledges sent fields; newer edits remain dirty against the new baseline. */
export function retainPendingModelEdits(
  current: readonly LoadedModelConfiguration[],
  sent: readonly LoadedModelConfiguration[],
  committed: readonly LoadedModelConfiguration[]
): LoadedModelConfiguration[] {
  const sentById = new Map(sent.map(model => [model.id, model]));
  const committedById = new Map(committed.map(model => [model.id, model]));
  return current.map(model => {
    const before = sentById.get(model.id);
    const saved = committedById.get(model.id);
    if (!before || !saved) return model;
    return {
      ...model,
      enabled: model.enabled === before.enabled ? saved.enabled : model.enabled,
      allowedUserTags: sameMembers(model.allowedUserTags, before.allowedUserTags)
        ? saved.allowedUserTags
        : model.allowedUserTags,
      allowedEntitlements: sameMembers(model.allowedEntitlements, before.allowedEntitlements)
        ? saved.allowedEntitlements
        : model.allowedEntitlements,
      fallbackModel:
        (model.fallbackModel ?? '') === (before.fallbackModel ?? '') ? saved.fallbackModel : model.fallbackModel,
      rank: model.rank === before.rank ? saved.rank : model.rank,
      accessEntry: saved.accessEntry,
    };
  });
}
