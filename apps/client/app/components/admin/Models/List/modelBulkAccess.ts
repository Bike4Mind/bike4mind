import type {
  ModelAccessAudienceEffect,
  ModelAccessBulkChange,
  ModelAccessBulkDryRun,
  ModelAccessBulkItem,
  ModelAccessBulkResult,
  ModelAccessEntry,
} from '@bike4mind/common';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';
import { changedFields, describeAccess, diffAccess, effectiveAccess } from '../Access/modelAccessChange';

export const MODEL_BULK_KINDS = [
  'turn-on',
  'turn-off',
  'add-tag',
  'remove-tag',
  'add-entitlement',
  'remove-entitlement',
] as const;
export type ModelBulkKind = (typeof MODEL_BULK_KINDS)[number];

export const MODEL_BULK_LABEL: Record<ModelBulkKind, string> = {
  'turn-on': 'Turn on',
  'turn-off': 'Turn off',
  'add-tag': 'Add tag',
  'remove-tag': 'Remove tag',
  'add-entitlement': 'Add entitlement',
  'remove-entitlement': 'Remove entitlement',
};

export const bulkKindTakesValues = (kind: ModelBulkKind): boolean => kind !== 'turn-on' && kind !== 'turn-off';
export const bulkKindIsTags = (kind: ModelBulkKind): boolean => kind === 'add-tag' || kind === 'remove-tag';

/** Base goes with the tags: an add-tag can also remove it, and a remove-tag can also give it back. */
export type BulkBaseFlags = { alsoRemoveBase?: boolean; alsoRestoreBase?: boolean };

/** The request's `change`; null until a tag or entitlement kind has at least one value. */
export const bulkChangeOf = (
  kind: ModelBulkKind,
  values: readonly string[],
  { alsoRemoveBase = false, alsoRestoreBase = false }: BulkBaseFlags = {}
): ModelAccessBulkChange | null => {
  if (kind === 'turn-on') return { enabled: true };
  if (kind === 'turn-off') return { enabled: false };
  if (values.length === 0) return null;
  const list = [...values];
  switch (kind) {
    case 'add-tag':
      return alsoRemoveBase ? { addTags: list, alsoRemoveBase: true } : { addTags: list };
    case 'remove-tag':
      return alsoRestoreBase ? { removeTags: list, alsoRestoreBase: true } : { removeTags: list };
    case 'add-entitlement':
      return { addEntitlements: list };
    case 'remove-entitlement':
      return { removeEntitlements: list };
  }
};

const REVERSE_KIND: Record<ModelBulkKind, ModelBulkKind> = {
  'turn-on': 'turn-off',
  'turn-off': 'turn-on',
  'add-tag': 'remove-tag',
  'remove-tag': 'add-tag',
  'add-entitlement': 'remove-entitlement',
  'remove-entitlement': 'add-entitlement',
};

/**
 * The bulk change that reverses one, for models its undo could not revert. A multi-value change can reach past what
 * it did on a model (removing a tag the model already had), so it goes through a fresh dry run like any other.
 */
export const reverseBulkChange = (
  kind: ModelBulkKind,
  { alsoRemoveBase = false, alsoRestoreBase = false }: BulkBaseFlags
): { kind: ModelBulkKind } & Required<BulkBaseFlags> => ({
  kind: REVERSE_KIND[kind],
  alsoRemoveBase: kind === 'remove-tag' && alsoRestoreBase,
  alsoRestoreBase: kind === 'add-tag' && alsoRemoveBase,
});

export const countOf = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

const unchangedPhrase = (kind: ModelBulkKind, values: readonly string[]) => {
  const subject = values.length === 1 ? 'it' : 'them';
  switch (kind) {
    case 'turn-on':
      return 'already on';
    case 'turn-off':
      return 'already off';
    case 'add-tag':
    case 'add-entitlement':
      return `already have ${subject}`;
    case 'remove-tag':
    case 'remove-entitlement':
      return `do not have ${subject}`;
  }
};

/** "Add tag beta: 37 change, 3 already have it"; "Turn off: 12 change, 5 already off". */
export const bulkDiffSummary = (
  kind: ModelBulkKind,
  values: readonly string[],
  counts: ModelAccessBulkDryRun['counts']
): string => {
  const head = bulkKindTakesValues(kind) ? `${MODEL_BULK_LABEL[kind]} ${values.join(', ')}` : MODEL_BULK_LABEL[kind];
  const unchanged =
    counts.unchanged > 0 ? `, ${counts.unchanged.toLocaleString()} ${unchangedPhrase(kind, values)}` : '';
  return `${head}: ${counts.change.toLocaleString()} change${unchanged}`;
};

/** Models the change edits without changing who can pick them: every user still reaches them through base. */
export const noAudienceChangeItems = (dryRun: ModelAccessBulkDryRun): ModelAccessBulkItem[] =>
  dryRun.items.filter(item => item.changes && item.audience === 'none' && item.everyoneThroughBase);

/** Offer "Also remove base" only where it would narrow something: an add-tag run on models that keep base. */
export const canAlsoRemoveBase = (kind: ModelBulkKind, dryRun: ModelAccessBulkDryRun | undefined): boolean =>
  kind === 'add-tag' &&
  !!dryRun &&
  dryRun.items.some(item => item.changes && item.after.allowedEntitlements.includes(BASE_ENTITLEMENT_KEY));

export const BULK_FAILURE_LABEL: Record<NonNullable<ModelAccessBulkResult['results'][number]['reason']>, string> = {
  'stamp-moved': 'changed by someone else since the preview',
  'write-error': 'the write failed',
};

export const failedResults = (result: ModelAccessBulkResult) =>
  result.results.filter(entry => entry.outcome === 'failed');

const accessOf = (entry: Omit<ModelAccessEntry, 'id' | 'updatedAt'> | null) =>
  entry
    ? effectiveAccess({
        enabled: entry.enabled,
        allowedUserTags: entry.allowedUserTags,
        allowedEntitlements: entry.allowedEntitlements,
        fallbackModel: entry.fallbackModel,
        rank: entry.rank,
      })
    : effectiveAccess(null);

/** Before and after for each field the change touches: "Tags: none \u2192 beta; On \u2192 Off". */
export const describeBulkEntry = (item: Pick<ModelAccessBulkItem, 'before' | 'after'>): string => {
  const before = accessOf(item.before);
  const after = accessOf(item.after);
  const fields = changedFields(diffAccess(before, after) ?? {});
  if (fields.length === 0) return 'No change';
  const from = describeAccess(before, fields);
  const to = describeAccess(after, fields);
  return fields
    .map((_, index) => {
      const label = from[index].match(/^[^:]+: /)?.[0] ?? '';
      return `${from[index]} \u2192 ${to[index].slice(label.length)}`;
    })
    .join('; ');
};

export const BULK_AUDIENCE_LABEL: Record<ModelAccessAudienceEffect, string> = {
  none: 'Same users as before',
  wider: 'More users can pick it',
  narrower: 'Fewer users can pick it',
  mixed: 'Some users gain it, others lose it',
};

const AUDIENCE_ORDER: ModelAccessAudienceEffect[] = ['narrower', 'mixed', 'wider', 'none'];
const AUDIENCE_PHRASE: Record<ModelAccessAudienceEffect, string> = {
  narrower: 'fewer users',
  mixed: 'a different set of users',
  wider: 'more users',
  none: 'the same users',
};

/** Who can pick the changed models afterwards: "Afterwards 30 reach fewer users, 7 reach the same users". */
export const bulkAudienceSummary = (items: readonly Pick<ModelAccessBulkItem, 'changes' | 'audience'>[]): string => {
  const changed = items.filter(item => item.changes);
  const parts = AUDIENCE_ORDER.map(effect => [effect, changed.filter(item => item.audience === effect).length] as const)
    .filter(([, count]) => count > 0)
    .map(
      ([effect, count]) => `${count.toLocaleString()} ${count === 1 ? 'reaches' : 'reach'} ${AUDIENCE_PHRASE[effect]}`
    );
  return parts.length > 0 ? `Afterwards ${parts.join(', ')}` : '';
};
