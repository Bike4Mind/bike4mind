/**
 * Defaults and ceilings for the per-user file-embedding window and the chunk-size change cooldown.
 * The settings that carry them live in `schemas/settings.ts` (the FILE_INDEXING_LIMITS group); the
 * readers are `fileEmbeddingService.enforceFileEmbeddingSpendWindow` and
 * `scopedSettingsService.claimScopedSettingChange`.
 */

/** USD a single user may spend on non-lake file embedding per window. 0 stops it. */
export const FILE_EMBEDDING_USER_BUDGET_PER_WINDOW_USD_DEFAULT = 1;
export const FILE_EMBEDDING_USER_BUDGET_PER_WINDOW_USD_MAX = 1_000;

/**
 * Embedded tokens a single user may send per window. Metered beside the USD budget because the
 * USD estimate is model-priced: a model with no listed price meters as free, and tokens are what
 * become stored vectors either way. 5M tokens is roughly 10K passages at the default chunk size.
 */
export const FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_DEFAULT = 5_000_000;
export const FILE_EMBEDDING_USER_TOKENS_PER_WINDOW_MAX = 1_000_000_000;

export const FILE_EMBEDDING_USER_WINDOW_HOURS_DEFAULT = 24;
export const FILE_EMBEDDING_USER_WINDOW_HOURS_MAX = 720;

/**
 * Minimum hours between two changes of one scope owner's `DefaultChunkSize`. A new chunk size
 * misses the embedding cache for every file it re-chunks, so each change re-embeds that owner's
 * corpus. Matches the default embedding window, so a scope owner re-embeds at most once per window.
 * 0 disables the cooldown.
 */
export const DEFAULT_CHUNK_SIZE_CHANGE_COOLDOWN_HOURS_DEFAULT = 24;
export const DEFAULT_CHUNK_SIZE_CHANGE_COOLDOWN_HOURS_MAX = 720;
