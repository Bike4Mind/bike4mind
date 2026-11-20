/**
 * Unsent composer text, kept on disk per conversation so a quit, an update restart, a reload or a
 * crash does not lose it. Main owns the file (main/chat/ComposerDraftStore); the renderer keeps a
 * copy in memory and sends changes (renderer/chat/composerDrafts).
 */

/** Session id -> unsent text. Only non-blank drafts are ever stored. */
export type ComposerDrafts = Record<string, string>;

/** Characters, not bytes. A longer draft stays in memory but is not written, rather than cut. */
export const COMPOSER_DRAFT_MAX_LENGTH = 200_000;

/** Characters across every draft; past it the least recently edited drafts are dropped first. */
export const COMPOSER_DRAFTS_TOTAL_MAX_LENGTH = 1_000_000;

/** A draft nobody has touched for this long is dropped when the file is next loaded (ms). */
export const COMPOSER_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A draft is worth keeping only when it holds something other than whitespace. */
export const isKeptDraft = (text: string): boolean => text.trim().length > 0;
