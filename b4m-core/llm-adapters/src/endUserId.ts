import { createHash } from 'crypto';

/**
 * Derive a stable, opaque per-end-user identifier to attach to direct LLM
 * provider requests: Anthropic `metadata.user_id` and OpenAI `safety_identifier`.
 *
 * Both providers use this value to scope abuse enforcement to an individual end
 * user rather than the whole organization/API account. Without it, a policy
 * violation by one end user can get the shared platform key throttled,
 * suspended, or banned, taking every user down with it. With it, the providers
 * can attribute abuse to a single user and (per their own guidance) narrow any
 * enforcement to that user.
 *
 * Both providers require an opaque value with no PII:
 *  - OpenAI `safety_identifier`: max 64 chars; hashing the username/email is the
 *    recommended way to avoid sending identifying information.
 *  - Anthropic `metadata.user_id`: a uuid, hash, or other opaque identifier;
 *    must not contain name, email address, or phone number.
 *
 * We SHA-256 the internal id so no plaintext identifier leaves our systems,
 * which is exactly the hashing both providers recommend. The limit of
 * that protection: an unsalted hash of a low-entropy input (an email, a
 * username) can be reversed by dictionary lookup, so callers should pass the
 * internal user id, never an email or username. We deliberately do not salt:
 * a salt would have to stay stable forever (rotating it severs the providers'
 * per-user history) and would be public in an open-source deployment anyway.
 * The hex digest is exactly 64 characters, within both providers' 64-char
 * limit, and is deterministic so a given user maps to the same identifier
 * across requests (which is what lets the providers track patterns per user
 * over time).
 *
 * Returns `undefined` for empty/absent input so callers can spread the result
 * conditionally and omit the field entirely when there is no end user to
 * attribute (e.g. system-initiated background tasks).
 */
export function toProviderEndUserId(internalId: string | null | undefined): string | undefined {
  if (!internalId) return undefined;
  const trimmed = String(internalId).trim();
  if (!trimmed) return undefined;
  return createHash('sha256').update(trimmed).digest('hex');
}
