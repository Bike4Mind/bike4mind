/**
 * Constants for CLI commands
 */

/**
 * Number of days to fetch for usage statistics
 */
export const USAGE_DAYS = 30;

/**
 * Column width for model names in usage display
 */
export const MODEL_NAME_COLUMN_WIDTH = 18;

/**
 * Cache TTL for usage data in milliseconds (5 minutes)
 */
export const USAGE_CACHE_TTL = 5 * 60 * 1000;

/**
 * Default TTL for a completed sub-agent's persisted conversation history, in ms
 * (1 hour). After this, the checkpoint is evicted and the session can no longer
 * be resumed. Overridable via CliConfig.preferences.subagentHistoryTtlMs.
 */
export const DEFAULT_SUBAGENT_HISTORY_TTL_MS = 60 * 60 * 1000;

/** Hard cap on retained sub-agent histories, to bound memory if the TTL never fires. */
export const MAX_SUBAGENT_HISTORY_ENTRIES = 100;

/**
 * Minimum number of lines in a paste to trigger the compact indicator
 * instead of rendering all pasted text inline
 */
export const PASTE_LINE_THRESHOLD = 5;

/**
 * Maximum paste size in characters (~500KB) to prevent memory issues
 * with extremely large pastes stored in Zustand state.
 */
export const MAX_PASTE_SIZE = 500_000;

/**
 * Maximum input length for running image detection (regex + filesystem ops).
 * Inputs longer than this skip image detection to avoid blocking the event loop.
 */
export const IMAGE_DETECTION_MAX_LENGTH = 500;

/**
 * Prefix tag marking a compaction summary message. Lives here (a leaf module)
 * rather than in compaction.ts so handoff.ts can detect it without importing
 * compaction.ts, which would form a cycle (compaction.ts imports handoff.ts).
 * Single source of truth so the summary builder and the handoff detector
 * cannot drift out of sync.
 */
export const COMPACTION_SUMMARY_MARKER = '[Previous conversation summary]';
