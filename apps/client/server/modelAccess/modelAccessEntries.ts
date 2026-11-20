import {
  normalizeEntitlementKey,
  type ModelAccessAudienceEffect,
  type ModelAccessBulkChange,
  type ModelAccessChange,
  type ModelAccessEntry,
} from '@bike4mind/common';
import { BASE_ENTITLEMENT_KEY } from '@bike4mind/server-utils/lib/entitlements/registry';

export const ACCESS_SETTING_NAME = 'llmModelConfigurations';

export type AccessFields = {
  enabled: boolean;
  allowedUserTags: string[];
  allowedEntitlements: string[];
  fallbackModel?: string;
  rank?: number;
};

/** One `settingValue[]` element. `updatedAt` is a BSON date; entries saved before per-entry stamps have none. */
export type StoredAccessEntry = AccessFields & { id: string; updatedAt?: Date };

/**
 * What a new entry starts from: getDefaultModelConfig (apps/client/app/hooks/data/llmModelConfig.ts) minus its
 * `enabled` default, which is false for catalog-disabled models and would keep them off after promotion.
 */
export const defaultAccessFields = (): AccessFields => ({
  enabled: true,
  allowedUserTags: [],
  allowedEntitlements: [BASE_ENTITLEMENT_KEY],
});

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function toStoredEntry(raw: unknown): StoredAccessEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
  return {
    id: entry.id,
    enabled: entry.enabled === true,
    allowedUserTags: strings(entry.allowedUserTags),
    allowedEntitlements: strings(entry.allowedEntitlements),
    ...(typeof entry.fallbackModel === 'string' && entry.fallbackModel && { fallbackModel: entry.fallbackModel }),
    ...(typeof entry.rank === 'number' && { rank: entry.rank }),
    ...(entry.updatedAt instanceof Date && { updatedAt: entry.updatedAt }),
  };
}

/** The first entry per id wins, as every reader's `find` does. */
export function indexEntries(raw: unknown): Map<string, StoredAccessEntry> {
  const byId = new Map<string, StoredAccessEntry>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = toStoredEntry(item);
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return byId;
}

export const accessFieldsOf = (entry: StoredAccessEntry | null | undefined): AccessFields =>
  entry
    ? {
        enabled: entry.enabled,
        allowedUserTags: entry.allowedUserTags,
        allowedEntitlements: entry.allowedEntitlements,
        ...(entry.fallbackModel && { fallbackModel: entry.fallbackModel }),
        ...(entry.rank !== undefined && { rank: entry.rank }),
      }
    : defaultAccessFields();

export const stampOf = (entry: StoredAccessEntry | null | undefined): string | null =>
  entry?.updatedAt ? entry.updatedAt.toISOString() : null;

export const toEntryView = (entry: StoredAccessEntry): ModelAccessEntry => ({
  id: entry.id,
  ...accessFieldsOf(entry),
  updatedAt: stampOf(entry),
});

export const buildEntry = (id: string, fields: AccessFields, updatedAt: Date): StoredAccessEntry => ({
  id,
  ...fields,
  updatedAt,
});

export type AccessEntryDocument = Omit<StoredAccessEntry, 'allowedEntitlements'> & { allowedEntitlements?: string[] };

/** As written to Mongo: empty entitlements are left out, as the retired whole-array PUT stored them. */
export const toEntryDocument = (entry: StoredAccessEntry): AccessEntryDocument => {
  const { allowedEntitlements, ...rest } = entry;
  return allowedEntitlements.length > 0 ? { ...rest, allowedEntitlements } : rest;
};

/** Strictly after the previous stamp, so two writes in one millisecond never share a stamp. */
export function nextStamp(previous: Date | undefined, now = new Date()): Date {
  return previous && previous.getTime() >= now.getTime() ? new Date(previous.getTime() + 1) : now;
}

const tagKey = (tag: string) => tag.trim().toLowerCase();

function union(current: string[], added: string[], key: (value: string) => string): string[] {
  const seen = new Set(current.map(key));
  const result = [...current];
  for (const value of added) {
    if (seen.has(key(value))) continue;
    seen.add(key(value));
    result.push(value);
  }
  return result;
}

const without = (current: string[], removed: string[], key: (value: string) => string): string[] => {
  const drop = new Set(removed.map(key));
  return current.filter(value => !drop.has(key(value)));
};

const distinct = (values: string[], key: (value: string) => string) => union([], values, key);

export function applyAccessChange(current: AccessFields, change: ModelAccessChange): AccessFields {
  const next: AccessFields = { ...current };
  if (change.enabled !== undefined) next.enabled = change.enabled;
  if (change.allowedUserTags) next.allowedUserTags = distinct(change.allowedUserTags, tagKey);
  if (change.allowedEntitlements) {
    next.allowedEntitlements = distinct(change.allowedEntitlements, normalizeEntitlementKey);
  }
  if (change.fallbackModel !== undefined) {
    if (change.fallbackModel) next.fallbackModel = change.fallbackModel;
    else delete next.fallbackModel;
  }
  if (change.rank !== undefined) {
    if (change.rank === null) delete next.rank;
    else next.rank = change.rank;
  }
  return next;
}

export function applyBulkChange(current: AccessFields, change: ModelAccessBulkChange): AccessFields {
  const base = [BASE_ENTITLEMENT_KEY];
  if ('enabled' in change) return { ...current, enabled: change.enabled };
  if ('addTags' in change) {
    return {
      ...current,
      allowedUserTags: union(current.allowedUserTags, change.addTags, tagKey),
      allowedEntitlements: change.alsoRemoveBase
        ? without(current.allowedEntitlements, base, normalizeEntitlementKey)
        : current.allowedEntitlements,
    };
  }
  if ('removeTags' in change) {
    return {
      ...current,
      allowedUserTags: without(current.allowedUserTags, change.removeTags, tagKey),
      allowedEntitlements: change.alsoRestoreBase
        ? union(current.allowedEntitlements, base, normalizeEntitlementKey)
        : current.allowedEntitlements,
    };
  }
  if ('addEntitlements' in change) {
    return {
      ...current,
      allowedEntitlements: union(current.allowedEntitlements, change.addEntitlements, normalizeEntitlementKey),
    };
  }
  return {
    ...current,
    allowedEntitlements: without(current.allowedEntitlements, change.removeEntitlements, normalizeEntitlementKey),
  };
}

const sortedKeys = (values: string[], key: (value: string) => string) => [...new Set(values.map(key))].sort();

/** Same access: tags and entitlements compare as sets, the way isModelAccessible reads them. */
export function sameAccess(a: AccessFields, b: AccessFields): boolean {
  return (
    a.enabled === b.enabled &&
    (a.fallbackModel ?? '') === (b.fallbackModel ?? '') &&
    a.rank === b.rank &&
    JSON.stringify(sortedKeys(a.allowedUserTags, tagKey)) === JSON.stringify(sortedKeys(b.allowedUserTags, tagKey)) &&
    JSON.stringify(sortedKeys(a.allowedEntitlements, normalizeEntitlementKey)) ===
      JSON.stringify(sortedKeys(b.allowedEntitlements, normalizeEntitlementKey))
  );
}

/** Enabled with no tags and no entitlements: isModelAccessible admits only admins. */
export const isAdminOnly = (fields: AccessFields): boolean =>
  fields.enabled && fields.allowedUserTags.length === 0 && fields.allowedEntitlements.length === 0;

export const reachesEveryoneThroughBase = (fields: AccessFields): boolean =>
  fields.enabled && fields.allowedEntitlements.some(key => normalizeEntitlementKey(key) === BASE_ENTITLEMENT_KEY);

type Audience = { everyone: boolean; groups: Set<string> };

// Access is tags OR entitlements (b4m-core/common/src/utils/modelHelpers.ts isModelAccessible), and every
// signed-in user holds `base`, so `base` covers every other group.
function audienceOf(fields: AccessFields): Audience {
  if (!fields.enabled) return { everyone: false, groups: new Set() };
  if (reachesEveryoneThroughBase(fields)) return { everyone: true, groups: new Set() };
  return {
    everyone: false,
    groups: new Set([
      ...fields.allowedUserTags.map(tag => `tag:${tagKey(tag)}`),
      ...fields.allowedEntitlements.map(key => `entitlement:${normalizeEntitlementKey(key)}`),
    ]),
  };
}

const covers = (outer: Audience, inner: Audience): boolean =>
  outer.everyone || (!inner.everyone && [...inner.groups].every(group => outer.groups.has(group)));

export function audienceEffect(before: AccessFields, after: AccessFields): ModelAccessAudienceEffect {
  const [from, to] = [audienceOf(before), audienceOf(after)];
  const wider = covers(to, from);
  const narrower = covers(from, to);
  if (wider && narrower) return 'none';
  if (wider) return 'wider';
  if (narrower) return 'narrower';
  return 'mixed';
}
