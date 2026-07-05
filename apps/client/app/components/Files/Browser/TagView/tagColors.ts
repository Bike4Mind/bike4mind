/**
 * Shared color palette and hash utility for tag-related views.
 * Used by TagCard, HomeViewPanel, and any future tag visualization.
 */

export const TAG_COLORS = [
  '#7C3AED', // violet
  '#2563EB', // blue
  '#059669', // emerald
  '#D97706', // amber
  '#DC2626', // red
  '#DB2777', // pink
  '#9333EA', // purple
  '#0891B2', // cyan
];

/**
 * Deterministic color from a string. Uses the root namespace segment
 * so that all tags under the same namespace share the same accent color.
 */
export function getTagColor(tagPath: string): string {
  const rootSegment = tagPath.split(':')[0];
  let hash = 0;
  for (let i = 0; i < rootSegment.length; i++) {
    hash = rootSegment.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}
