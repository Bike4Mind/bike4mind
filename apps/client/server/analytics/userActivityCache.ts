/**
 * Window caching for GET /api/users/counterLogs.
 *
 * The User Activity aggregation costs ~8-9s and ~1.5GB on a 7-day production window, and the
 * $skip/$limit at the end only trims a result the pipeline has already materialized. Caching one
 * PAGE per key therefore made browsing N pages cost N full aggregations, and a CSV export - which
 * walks the endpoint page by page - cost one per page.
 *
 * So the cache entry is a prefix of the sorted result set rather than a single page: one
 * aggregation per filter set, sliced per page. Two bounds keep that safe:
 *
 *  - CACHE_MAX_BYTES, because the entry is one Mongo document and the 16MB BSON limit is exactly
 *    what the old unpaginated cache write blew past.
 *  - MAX_CACHED_ROWS, because the rows are held in Lambda memory before they are written.
 *
 * A page past either bound is fetched on its own and not cached, so the bounds cost efficiency,
 * never correctness.
 */

/** Rows of a window kept in one cache entry. Sized to cover a whole CSV export in one pass. */
export const MAX_CACHED_ROWS = 50_000;

/**
 * Byte budget for the cached rows. Well under Mongo's 16MB document limit: the measure below is
 * of the JSON, and the same text as BSON with non-ASCII metadata can run somewhat larger.
 */
export const CACHE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Pages a single aggregation reads ahead. Only a lower bound on the window - a request for a
 * later page widens it to reach that page instead of paying for a second aggregation.
 */
export const CACHE_WINDOW_PAGES = 10;

/** A cached prefix of the sorted result set, always starting at offset 0. */
export interface UserActivityWindow {
  rows: unknown[];
  /** Rows matching the filter set, which is `rows.length` only when the whole set fits. */
  total: number;
  /** The byte budget cut this window short of what was fetched, so it cannot be grown by re-asking. */
  truncated: boolean;
}

/**
 * Rows to materialize so the window reaches `skip + limit`, or null when that page is past
 * MAX_CACHED_ROWS and has to be fetched on its own.
 *
 * `floor` (an existing window's length) keeps a request for an early page from shrinking a window
 * a later page already paid for, which would otherwise re-aggregate on every alternation.
 */
export function windowRowsFor(skip: number, limit: number, floor = 0): number | null {
  const pageEnd = skip + limit;
  if (pageEnd > MAX_CACHED_ROWS) return null;
  return Math.min(Math.max(pageEnd, limit * CACHE_WINDOW_PAGES, floor), MAX_CACHED_ROWS);
}

/**
 * Whether `window` can answer this page. `total <= rows.length` covers a page past the end of a
 * fully-cached result set: the empty slice is the right answer, not a miss.
 */
export function windowCoversPage(window: UserActivityWindow, skip: number, limit: number): boolean {
  return skip + limit <= window.rows.length || window.total <= window.rows.length;
}

/** The page `skip`/`limit` asked for, taken out of a window that covers it. */
export function sliceWindow(window: UserActivityWindow, skip: number, limit: number): unknown[] {
  return window.rows.slice(skip, skip + limit);
}

/** Builds the cache entry for a freshly fetched window, trimmed to the byte budget. */
export function buildWindow(rows: unknown[], total: number, budgetBytes = CACHE_MAX_BYTES): UserActivityWindow {
  let used = 0;
  for (let i = 0; i < rows.length; i++) {
    // +1 for the separating comma; the enclosing brackets are noise at this scale.
    used += Buffer.byteLength(JSON.stringify(rows[i]) ?? 'null') + 1;
    if (used > budgetBytes) {
      return { rows: rows.slice(0, i), total, truncated: true };
    }
  }
  return { rows, total, truncated: false };
}

/** Narrows a cache document's untyped `result` to a window, rejecting entries of any older shape. */
export function asWindow(result: unknown): UserActivityWindow | null {
  if (!result || typeof result !== 'object') return null;
  const { rows, total } = result as Partial<UserActivityWindow>;
  if (!Array.isArray(rows) || typeof total !== 'number') return null;
  return { rows, total, truncated: (result as UserActivityWindow).truncated === true };
}
