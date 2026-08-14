import type { CounterLogRow } from '@client/app/utils/userAPICalls';

/**
 * Per-request page size, at the endpoint's own MAX_PAGE_SIZE: 5000 turns a 50k export into 10
 * round trips instead of 25. The server caches a window of the sorted result set that spans the
 * whole export, so those trips share one aggregation - keep this at or below the server's
 * MAX_CACHED_ROWS (server/analytics/userActivityCache.ts) or the tail pages fall out of it.
 */
export const EXPORT_PAGE_SIZE = 5000;
/** Hard ceiling on an export, so a broad filter can't page indefinitely. */
export const MAX_EXPORT_ROWS = 50000;

type FetchPage = (page: number, limit: number) => Promise<{ logs: CounterLogRow[]; total: number }>;

interface CollectOptions {
  pageSize?: number;
  maxRows?: number;
  onProgress?: (collected: number, total: number) => void;
}

/**
 * Walks the paged User Activity endpoint and accumulates every matching row for CSV export.
 *
 * The grid only ever holds one page, so exporting what is on screen would silently drop the
 * rest. Bounded by `maxRows`: `truncated` tells the caller to warn that the file is partial.
 */
export async function collectUserActivityRows(
  fetchPage: FetchPage,
  { pageSize = EXPORT_PAGE_SIZE, maxRows = MAX_EXPORT_ROWS, onProgress }: CollectOptions = {}
): Promise<{ rows: CounterLogRow[]; total: number; truncated: boolean }> {
  const rows: CounterLogRow[] = [];
  let total = 0;
  let page = 1;

  for (;;) {
    if (rows.length >= maxRows) break;

    // `limit` is deliberately constant across the whole walk: the server derives its $skip from
    // (page - 1) * limit, so shrinking the last request to fit `maxRows` would move the window
    // and silently re-fetch rows already collected while skipping the tail. Over-fetch, then trim.
    const result = await fetchPage(page, pageSize);
    total = result.total ?? 0;
    const batch = result.logs ?? [];
    rows.push(...batch.slice(0, maxRows - rows.length));
    onProgress?.(rows.length, total);

    // A short page means the server has nothing left to give.
    if (batch.length < pageSize) break;
    page += 1;
  }

  return { rows, total, truncated: rows.length < total };
}
