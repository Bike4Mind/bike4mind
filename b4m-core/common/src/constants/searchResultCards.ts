/**
 * The fence language the model writes to place image cards inline in a reply, shared because three
 * places must agree on it and nothing else would catch a mismatch:
 *   - WEB_SEARCH_CARDS_PROMPT (@bike4mind/services) teaches the model to emit it,
 *   - the reply renderer (apps/client .../Session/PromptReplies.tsx) intercepts it,
 *   - the notebook curation extractor skips it instead of curating raw JSON as a code artifact.
 *
 * MUST contain only `\w` characters: both the renderer (`/language-(\w+)/`) and the curation
 * extractor (```` /```(\w+)?/ ````) capture the language with `\w+`, so a hyphen would silently
 * truncate this and the cards would never render.
 */
export const SEARCH_RESULT_CARDS_LANGUAGE = 'b4m_cards';
