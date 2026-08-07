/**
 * Cost ceiling for the lake memory producer, keyed PER LAKE (not per user): a burst of batch
 * finalizes for one lake triggers at most one full-lake extraction per window. A full extraction
 * re-scans the whole lake, so one run per window already picks up everything a burst uploaded; the
 * cap just stops each finalize from re-running an expensive LLM pass over the same corpus.
 *
 * Same key format as the `rateLimit` middleware / taxonomy cap (`rate-limit:<id>:<bucket>`), so it
 * rides the existing fixed-window counter in the cache repository.
 */
export const LAKE_MEMORY_DAILY_CAP = 6;
export const LAKE_MEMORY_RATE_LIMIT_BUCKET = 'data-lakes/lake-memory-extraction';
export const LAKE_MEMORY_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const lakeMemoryRateLimitKey = (dataLakeId: string) =>
  `rate-limit:${dataLakeId}:${LAKE_MEMORY_RATE_LIMIT_BUCKET}`;
