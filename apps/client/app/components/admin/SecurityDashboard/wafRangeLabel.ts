import type { WafRangeInput } from '@/server/security/wafSharedHelpers';

/**
 * Format a WafRangeInput for chart/table headers.
 * Preset ranges render as "Last 1h" and custom ranges as a start-end pair, each suffixed with UTC.
 */
export function formatRangeLabel(range: WafRangeInput): string {
  if (typeof range === 'object') {
    const start = new Date(range.start).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    const end = new Date(range.end).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    return `${start} – ${end} • UTC`;
  }
  return `Last ${range} • UTC`;
}
