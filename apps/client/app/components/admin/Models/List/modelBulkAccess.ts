import type {
  ModelAccessBulkChange,
  ModelAccessBulkDryRun,
  ModelAccessBulkItem,
  ModelAccessBulkResult,
} from '@bike4mind/common';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';

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

/** The request's `change`; null until a tag or entitlement kind has at least one value. */
export const bulkChangeOf = (
  kind: ModelBulkKind,
  values: readonly string[],
  alsoRemoveBase: boolean
): ModelAccessBulkChange | null => {
  if (kind === 'turn-on') return { enabled: true };
  if (kind === 'turn-off') return { enabled: false };
  if (values.length === 0) return null;
  const list = [...values];
  switch (kind) {
    case 'add-tag':
      return alsoRemoveBase ? { addTags: list, alsoRemoveBase: true } : { addTags: list };
    case 'remove-tag':
      return { removeTags: list };
    case 'add-entitlement':
      return { addEntitlements: list };
    case 'remove-entitlement':
      return { removeEntitlements: list };
  }
};

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

export const describeBulkEntry = (item: Pick<ModelAccessBulkItem, 'before' | 'after'>): string => {
  const { after } = item;
  const parts = [
    after.enabled ? 'On' : 'Off',
    after.allowedUserTags.length > 0 ? `tags ${after.allowedUserTags.join(', ')}` : 'no tags',
    after.allowedEntitlements.length > 0 ? `entitlements ${after.allowedEntitlements.join(', ')}` : 'no entitlements',
  ];
  return parts.join('; ');
};
