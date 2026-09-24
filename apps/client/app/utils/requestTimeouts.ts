// Per-request timeouts for calls whose never-settling await would strand the composer.
// Deliberately not a global axios default: uploads and long LLM calls run far longer.

/** Send-path requests that only create or enqueue work (session create, /api/ai/llm, agent attach). */
export const SEND_REQUEST_TIMEOUT_MS = 30_000;

/** Websocket connect-ticket mint. A rejection feeds react-use-websocket's getUrl retry/backoff. */
export const WEBSOCKET_TICKET_TIMEOUT_MS = 10_000;
