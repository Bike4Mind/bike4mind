/**
 * Pure date-grouping/sorting helpers extracted from CombinedNotebooks so they can be
 * unit-tested in isolation. Framework-free and generic: no React, no app types.
 */

// Relative-date buckets emitted by getDateLabel, in display order. Lower = higher up the list.
const DATE_GROUP_PRIORITY: Record<string, number> = {
  Today: 1,
  Yesterday: 2,
  'Previous 7 Days': 3,
  'Previous 30 Days': 4,
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Comparator for date-group keys produced by getDateLabel. Orders the relative-date
 * buckets first (Today -> Yesterday -> Previous 7 Days -> Previous 30 Days), then month
 * labels most-recent-first (by year when present, then month), falling back to
 * alphabetical for anything else.
 */
export function compareDateGroupKeys(a: string, b: string): number {
  const priorityA = DATE_GROUP_PRIORITY[a];
  const priorityB = DATE_GROUP_PRIORITY[b];

  // Both special date labels -> sort by priority
  if (priorityA && priorityB) {
    return priorityA - priorityB;
  }
  // Only one is a special date label -> it comes first
  if (priorityA) return -1;
  if (priorityB) return 1;

  // Month names: parse and sort most recent first
  const monthIndexA = MONTHS.findIndex(month => a.includes(month));
  const monthIndexB = MONTHS.findIndex(month => b.includes(month));

  if (monthIndexA !== -1 && monthIndexB !== -1) {
    const yearA = a.match(/\d{4}/);
    const yearB = b.match(/\d{4}/);

    if (yearA && yearB) {
      // Compare years first (most recent year first)
      const yearDiff = parseInt(yearB[0]) - parseInt(yearA[0]);
      if (yearDiff !== 0) return yearDiff;
    }

    // Same year or no year, compare months (reverse order for most recent first)
    return monthIndexB - monthIndexA;
  }

  // Fallback to alphabetical
  return a.localeCompare(b);
}

/**
 * Group items under a date label, de-duplicating by `id` and preserving first occurrence.
 * Returns an empty object for an empty input.
 */
export function groupItemsByDate<T extends { id: string }>(
  items: T[],
  getLabel: (item: T) => string
): Record<string, T[]> {
  return items.reduce(
    (res, cur) => {
      const groupName = getLabel(cur);
      res[groupName] ||= [];
      if (!res[groupName].some(d => d.id === cur.id)) {
        res[groupName].push(cur);
      }
      return res;
    },
    {} as Record<string, T[]>
  );
}
