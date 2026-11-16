import type { AdminModelAccessEntry, ModelAccessChange } from '@bike4mind/common';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';

/** An access entry with every field present: what the model behaves as. */
export type EffectiveAccess = {
  enabled: boolean;
  allowedUserTags: string[];
  allowedEntitlements: string[];
  fallbackModel: string;
  rank: number | null;
};

/**
 * A model with no entry is open to everyone through `base`, the entry the server would create for it
 * (apps/client/server/modelAccess/modelAccessEntries.ts).
 */
export const effectiveAccess = (entry: AdminModelAccessEntry | null | undefined): EffectiveAccess => ({
  enabled: entry?.enabled ?? true,
  allowedUserTags: entry?.allowedUserTags ?? [],
  allowedEntitlements: entry ? entry.allowedEntitlements : [BASE_ENTITLEMENT_KEY],
  fallbackModel: entry?.fallbackModel ?? '',
  rank: entry?.rank ?? null,
});

export const applyAccessChange = (access: EffectiveAccess, change: ModelAccessChange): EffectiveAccess => ({
  enabled: change.enabled ?? access.enabled,
  allowedUserTags: change.allowedUserTags ?? access.allowedUserTags,
  allowedEntitlements: change.allowedEntitlements ?? access.allowedEntitlements,
  fallbackModel: change.fallbackModel === undefined ? access.fallbackModel : (change.fallbackModel ?? ''),
  rank: change.rank === undefined ? access.rank : change.rank,
});

/** Enabled with no tags and no entitlements: hidden from every user, still listed for admins. */
export const isAdminsOnly = (access: EffectiveAccess): boolean =>
  access.enabled && access.allowedUserTags.length === 0 && access.allowedEntitlements.length === 0;

const sameList = (a: readonly string[], b: readonly string[]) => {
  const sortedB = [...b].sort();
  return a.length === b.length && [...a].sort().every((value, index) => value === sortedB[index]);
};

/** Only the fields that differ from `before`; null when nothing would change. */
export const diffAccess = (before: EffectiveAccess, after: EffectiveAccess): ModelAccessChange | null => {
  const change: ModelAccessChange = {};
  if (before.enabled !== after.enabled) change.enabled = after.enabled;
  if (!sameList(before.allowedUserTags, after.allowedUserTags)) change.allowedUserTags = after.allowedUserTags;
  if (!sameList(before.allowedEntitlements, after.allowedEntitlements))
    change.allowedEntitlements = after.allowedEntitlements;
  if (before.fallbackModel !== after.fallbackModel) change.fallbackModel = after.fallbackModel;
  if (before.rank !== after.rank) change.rank = after.rank;
  return Object.keys(change).length > 0 ? change : null;
};

/** The change that puts back what `change` overwrote. */
export const inverseAccessChange = (before: EffectiveAccess, change: ModelAccessChange): ModelAccessChange =>
  diffAccess(applyAccessChange(before, change), before) ?? {};

const listText = (values: readonly string[]) => (values.length > 0 ? values.join(', ') : 'none');

/** One line per changed field, for ChangePreview and the undo toast. */
export const describeAccess = (access: EffectiveAccess, fields: readonly (keyof EffectiveAccess)[]): string[] =>
  fields.map(field => {
    switch (field) {
      case 'enabled':
        return access.enabled ? 'On' : 'Off';
      case 'allowedUserTags':
        return `Tags: ${listText(access.allowedUserTags)}`;
      case 'allowedEntitlements':
        return `Entitlements: ${listText(access.allowedEntitlements)}`;
      case 'fallbackModel':
        return `Fallback: ${access.fallbackModel || 'automatic'}`;
      case 'rank':
        return `Rank: ${access.rank ?? 'automatic'}`;
    }
  });

export const changedFields = (change: ModelAccessChange): (keyof EffectiveAccess)[] =>
  (Object.keys(change) as (keyof ModelAccessChange)[]).filter(key => change[key] !== undefined);
