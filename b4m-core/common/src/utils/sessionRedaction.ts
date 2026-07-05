import type { ISession } from '../types/entities/SessionTypes';

/**
 * Session fields that are SERVER-OWNED and must never be serialized to a client.
 *
 * `systemPromptText` holds proprietary, server-authored prompts (the optimizer,
 * medical-reference, and pathway-generator product surfaces). It is written server-side at
 * session creation and consumed server-side by the completion engine - no client
 * consumer reads it. Returning it on a session read leaks the prompt to anyone who can
 * access the session, including a non-entitled user it was deliberately shared with.
 *
 * This list is the single source of truth: add a field here and every response boundary
 * that routes through {@link redactSessionForClient} inherits the redaction. Any future
 * need to echo a server-owned field to its owner must be a dedicated, separately-authorized
 * endpoint - never a relaxation of this strip.
 */
export const SERVER_OWNED_SESSION_FIELDS = ['systemPromptText'] as const;

export type ServerOwnedSessionField = (typeof SERVER_OWNED_SESSION_FIELDS)[number];

/** A session shape safe to serialize to a client - server-owned fields removed. */
export type ClientSession<T> = Omit<T, ServerOwnedSessionField>;

/**
 * Strip server-owned fields from a single session for client serialization.
 *
 * Returns a SHALLOW COPY with the fields removed - it MUST NOT mutate the input. The
 * same in-memory session object is read for `systemPromptText` before being returned in
 * some handlers (e.g. `/api/ai/llm` reads it at request time, then responds), and the
 * completion engine shares the `findById`/`toJSON` plain-object reads with client routes.
 * Mutating in place would starve the engine of the prompt.
 *
 * Null/undefined pass through unchanged so callers can redact optional results directly.
 */
export function redactSessionForClient<T extends Partial<ISession>>(session: T): ClientSession<T>;
export function redactSessionForClient<T extends Partial<ISession>>(session: T | null): ClientSession<T> | null;
export function redactSessionForClient<T extends Partial<ISession>>(
  session: T | null | undefined
): ClientSession<T> | null | undefined;
export function redactSessionForClient<T extends Partial<ISession>>(
  session: T | null | undefined
): ClientSession<T> | null | undefined {
  if (session == null) return session;
  // Normalize Mongoose documents to a plain object first. Many read paths return live
  // documents and rely on `res.json` calling their `toJSON()`; spreading a live document
  // copies internal state (`_doc`/`$__`), not the fields. Duck-typed so this helper stays
  // free of a Mongoose dependency.
  const maybeDoc = session as { toJSON?: () => Record<string, unknown> };
  const plain = typeof maybeDoc.toJSON === 'function' ? maybeDoc.toJSON() : session;
  const clientSession = { ...plain } as Record<string, unknown>;
  for (const field of SERVER_OWNED_SESSION_FIELDS) {
    delete clientSession[field];
  }
  return clientSession as ClientSession<T>;
}

/** Strip server-owned fields from an array of sessions for client serialization. */
export function redactSessionsForClient<T extends Partial<ISession>>(sessions: T[]): ClientSession<T>[] {
  return sessions.map(session => redactSessionForClient(session));
}
