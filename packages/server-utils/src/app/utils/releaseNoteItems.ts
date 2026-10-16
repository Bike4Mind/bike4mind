import { ReleaseNoteCategorySchema, type ReleaseNoteCategory } from '@bike4mind/common';

// Record (not an array) so a new category in the schema fails typecheck here rather than dropping its items.
const CATEGORY_HEADINGS: Record<ReleaseNoteCategory, string> = {
  new: 'New',
  improved: 'Improved',
  fixed: 'Fixed',
};

/** A note's items under their category heading, most notable first; empty categories are left out. */
export function groupReleaseNoteItems<T extends { category: ReleaseNoteCategory; importance: number }>(
  items: readonly T[]
): Array<{ heading: string; items: T[] }> {
  // Iterate the schema's own values so the heading order stays the schema's order.
  return ReleaseNoteCategorySchema.options.flatMap(category => {
    // importance 1 is the most notable, so ascending order leads with it
    const grouped = items.filter(item => item.category === category).sort((a, b) => a.importance - b.importance);
    return grouped.length > 0 ? [{ heading: CATEGORY_HEADINGS[category], items: grouped }] : [];
  });
}
