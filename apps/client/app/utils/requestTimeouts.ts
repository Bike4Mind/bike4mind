// Per-request timeouts for calls whose never-settling await would strand the composer.
// Deliberately not a global axios default: uploads and long LLM calls run far longer.

/**
 * Send-path requests that only create or enqueue work (session create, /api/ai/llm, agent attach).
 * Must stay >= the server's own ceiling - the Next server Lambda timeout (infra/web.ts) and the
 * CloudFront originReadTimeout (infra/router.ts), both 60s. Aborting earlier while the server
 * still finishes lets a retry create a second, separately billed quest.
 */
export const SEND_REQUEST_TIMEOUT_MS = 60_000;

/** Websocket connect-ticket mint. A rejection feeds react-use-websocket's getUrl retry/backoff. */
export const WEBSOCKET_TICKET_TIMEOUT_MS = 10_000;
