/**
 * Pure helpers for collapsing API-created notebooks inside one date bucket of the sidebar list
 * (see NotebookGroupList). Framework-free, like the sibling dateGrouping.ts.
 */

export type BucketRow<T> = { kind: 'item'; item: T } | { kind: 'apiGroup'; key: string; items: T[] };

/** Fewer API notebooks than this in a bucket render as plain rows; a group of one only adds a click. */
export const MIN_API_GROUP_SIZE = 2;

/** True for a session row stamped with the 'api' origin (see ISession.origin). */
export function isApiOriginItem(item: unknown): boolean {
  if (!item || typeof item !== 'object' || !('origin' in item)) return false;
  const origin = (item as { origin?: { channel?: unknown } }).origin;
  return origin?.channel === 'api';
}

/**
 * Returns the bucket's rows with every API item (consecutive or not) folded into one group row,
 * placed where the bucket's first API item was, so the group sorts by its most recent member.
 * Input order is preserved otherwise. `bucketKey` names the group so its expansion state can be
 * remembered per bucket.
 */
export function collapseApiItems<T>(
  items: T[],
  bucketKey: string,
  isApi: (item: T) => boolean = isApiOriginItem
): BucketRow<T>[] {
  const apiItems = items.filter(isApi);
  if (apiItems.length < MIN_API_GROUP_SIZE) return items.map(item => ({ kind: 'item', item }));

  const rows: BucketRow<T>[] = [];
  let groupPlaced = false;
  for (const item of items) {
    if (!isApi(item)) {
      rows.push({ kind: 'item', item });
    } else if (!groupPlaced) {
      rows.push({ kind: 'apiGroup', key: bucketKey, items: apiItems });
      groupPlaced = true;
    }
  }
  return rows;
}
