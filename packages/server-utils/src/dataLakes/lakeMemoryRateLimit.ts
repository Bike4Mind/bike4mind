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

/**
 * Hard ceiling on how many slices ONE extraction chain runs before it stops re-enqueuing itself. The
 * daily cap above bounds how OFTEN a chain STARTS (per finalize); this is the independent bound on how
 * LONG a single chain runs, so a pathologically large lake cannot silently turn one finalize into an
 * unbounded run of LLM-billed slices - the failure mode that only shows up on a bill.
 *
 * At MAX_DOCS_PER_RUN=100 docs/slice this covers up to ~2000 docs in a single chain, which comfortably
 * clears any realistically-sized lake. A lake larger than that is not dropped: the chain logs loudly and
 * stops, and because the continuation cursor is persisted, the next batch finalize resumes from where the
 * chain left off. So this caps per-chain SPEND, not eventual coverage.
 */
export const LAKE_MEMORY_MAX_CONTINUATION_SLICES = 20;

export const lakeMemoryRateLimitKey = (dataLakeId: string) =>
  `rate-limit:${dataLakeId}:${LAKE_MEMORY_RATE_LIMIT_BUCKET}`;
