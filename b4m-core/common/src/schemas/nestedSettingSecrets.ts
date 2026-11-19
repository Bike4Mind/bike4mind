/**
 * Secret fields nested inside an object setting's value, declared on the definition
 * (BaseSetting.nestedSecrets in ./settings.ts) so reads, broadcasts and the update route treat
 * every such setting the same way. Kept free of crypto: the update route supplies the storing step.
 */

/** One array of objects, under a top-level key of the value, whose items carry secret fields. */
export interface NestedSecretGroup {
  arrayKey: string;
  /** Fields that tell one item from another across saves, so a masked field keeps ITS stored value. */
  identityFields: readonly string[];
  secretFields: readonly string[];
}

/**
 * What a set nested secret is replaced with on its way out of the server. Coming back on a write
 * it means "keep what is stored" (apps/client/pages/api/settings/update.ts). Eight U+2022 bullets.
 */
export const NESTED_SECRET_PLACEHOLDER = '\u2022'.repeat(8);

const RESERVED_FIELD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(field => typeof field === 'string' && field.trim() !== '' && !RESERVED_FIELD_NAMES.has(field))
  );
}

/** True for a non-empty list of well-formed groups; a field cannot be both identity and secret. */
export function isValidNestedSecretGroups(groups: unknown): groups is NestedSecretGroup[] {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  return groups.every(
    group =>
      isRecord(group) &&
      typeof group.arrayKey === 'string' &&
      group.arrayKey.trim() !== '' &&
      !RESERVED_FIELD_NAMES.has(group.arrayKey) &&
      isFieldList(group.identityFields) &&
      isFieldList(group.secretFields) &&
      !group.secretFields.some(field => (group.identityFields as string[]).includes(field))
  );
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** True when any declared secret field of `value` holds something. */
export function hasNestedSecretValue(value: unknown, groups: readonly NestedSecretGroup[]): boolean {
  if (!isRecord(value)) return false;
  return groups.some(group => {
    const items = value[group.arrayKey];
    return (
      Array.isArray(items) && items.some(item => isRecord(item) && group.secretFields.some(field => isSet(item[field])))
    );
  });
}

/** A copy of `value` with every set secret field replaced by the placeholder. Unset fields stay as they are. */
export function redactNestedSecrets(value: unknown, groups: readonly NestedSecretGroup[]): unknown {
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = { ...value };
  for (const group of groups) {
    const items = redacted[group.arrayKey];
    if (!Array.isArray(items)) continue;
    redacted[group.arrayKey] = items.map(item => {
      if (!isRecord(item)) return item;
      const copy = { ...item };
      for (const field of group.secretFields) {
        if (isSet(copy[field])) copy[field] = NESTED_SECRET_PLACEHOLDER;
      }
      return copy;
    });
  }
  return redacted;
}

function isSameItem(a: Record<string, unknown>, b: Record<string, unknown>, identityFields: readonly string[]) {
  return identityFields.every(field => {
    const value = a[field];
    // An item with no identity matches nothing, so it can never pick up another item's secret.
    return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') && value === b[field];
  });
}

/**
 * A copy of `value` with `store(submitted, stored)` applied to every set secret field. `stored` is
 * the same field of the item in `storedValue` with the same identity (never the same array index),
 * or undefined when there is none. Throws on a set secret field that is not a string.
 */
export function mapNestedSecrets(
  value: unknown,
  storedValue: unknown,
  groups: readonly NestedSecretGroup[],
  store: (submitted: string, stored: string | undefined) => string
): unknown {
  if (!isRecord(value)) return value;
  const mapped: Record<string, unknown> = { ...value };
  for (const group of groups) {
    const items = mapped[group.arrayKey];
    if (!Array.isArray(items)) continue;
    const storedItems = isRecord(storedValue) ? storedValue[group.arrayKey] : undefined;
    const storedRecords = Array.isArray(storedItems) ? storedItems.filter(isRecord) : [];
    mapped[group.arrayKey] = items.map(item => {
      if (!isRecord(item)) return item;
      const storedItem = storedRecords.find(candidate => isSameItem(item, candidate, group.identityFields));
      const copy = { ...item };
      for (const field of group.secretFields) {
        const submitted = copy[field];
        if (!isSet(submitted)) continue;
        if (typeof submitted !== 'string') {
          throw new TypeError(`Secret field ${group.arrayKey}[].${field} must be a string`);
        }
        const stored = storedItem?.[field];
        copy[field] = store(submitted, typeof stored === 'string' ? stored : undefined);
      }
      return copy;
    });
  }
  return mapped;
}
