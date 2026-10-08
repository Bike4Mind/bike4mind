import type { ReleaseNoteCategory } from '@bike4mind/common';

const CATEGORY_HEADINGS: Array<[ReleaseNoteCategory, string]> = [
  ['new', 'New'],
  ['improved', 'Improved'],
  ['fixed', 'Fixed'],
];

/** A note's items under their category heading, most notable first; empty categories are left out. */
export function groupReleaseNoteItems<T extends { category: ReleaseNoteCategory; importance: number }>(
  items: readonly T[]
): Array<{ heading: string; items: T[] }> {
  return CATEGORY_HEADINGS.flatMap(([category, heading]) => {
    // importance 1 is the most notable, so ascending order leads with it
    const grouped = items.filter(item => item.category === category).sort((a, b) => a.importance - b.importance);
    return grouped.length > 0 ? [{ heading, items: grouped }] : [];
  });
}
