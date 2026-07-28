import type { CounterLogRow } from '@client/app/utils/userAPICalls';

/** Per-request page size. Kept well under Lambda's 6MB response cap. */
export const EXPORT_PAGE_SIZE = 2000;
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
    const limit = Math.min(pageSize, maxRows - rows.length);
    if (limit <= 0) break;

    const result = await fetchPage(page, limit);
    total = result.total ?? 0;
    // Trim rather than trust the page size: the cap has to hold even if a server returns more.
    rows.push(...(result.logs ?? []).slice(0, limit));
    onProgress?.(rows.length, total);

    // A short page means the server has nothing left to give.
    if ((result.logs?.length ?? 0) < limit) break;
    page += 1;
  }

  return { rows, total, truncated: rows.length < total };
}
