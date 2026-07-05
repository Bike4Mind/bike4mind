/**
 * Session management - split into focused responsibility modules:
 *
 * - `sessionCrud`        - lifecycle, querying, basic persistence
 * - `sessionOperations`  - message CRUD, fork/clone/snip, generation control, summarization
 * - `sessionSideEffects` - WebSocket notifications, analytics, activity logging, event publishing
 *
 * This file re-exports the public surface so existing callers importing from
 * `@server/managers/sessionManager` continue to work unchanged. Prefer importing from
 * the specific module directly in new code.
 *
 * `sessionSideEffects` is intentionally NOT re-exported here: its helpers are
 * fire-and-forget internals composed by the two modules above and must never be
 * called directly by API routes. Code that legitimately needs them imports
 * `./sessionSideEffects` directly.
 */
export * from './sessionCrud';
export * from './sessionOperations';
