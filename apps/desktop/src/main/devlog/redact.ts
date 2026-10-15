/**
 * Credential scrubbing for the developer log.
 *
 * The first line of defence is the PUBLISHER: a source names the fields it wants logged rather
 * than spreading an object, so a token is never offered in the first place. This is the second
 * line, and it runs inside the sink so a future source cannot bypass it - including one written
 * by someone who has not read that rule.
 *
 * Patterns are deliberately blunt. A dev log that redacts an identifier it did not have to is a
 * nuisance; one that keeps a bearer token is the thing this whole feature is not allowed to be.
 */

const REDACTED = '[redacted]';

/**
 * `Authorization: Bearer x`, and the same idea spelled as a field. The value runs to the first
 * character that cannot be in a token, so a message with text after it keeps that text. Eight
 * characters minimum, so "authorization header missing" is still a sentence.
 */
const BEARER = /\b(bearer|authorization)([\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** A JWT: the access token this app actually holds. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/**
 * Anything named as a secret and then ASSIGNED one: `token=x`, `"device_code": "x"`. Covers the
 * device flow's own codes, which are too short to match on shape alone.
 *
 * An explicit `:` or `=` is required, because a bare space makes the next word of any sentence
 * mentioning a token look like its value.
 */
const NAMED_SECRET =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|device[_-]?code|user[_-]?code|client[_-]?secret|api[_-]?key|apikey|password|passwd|secret|token)("?\s*[:=]\s*"?)[^\s",}]+/gi;

/**
 * A long opaque run. 40 characters rather than 32 so a uuid - 36 with its dashes, and the shape
 * of every session id in this app - stays readable; real tokens are longer than that.
 */
const OPAQUE = /[A-Za-z0-9_+/=-]{40,}/g;

/** Scrub one string. Safe to run on anything; it only ever shortens. */
export function redact(value: string): string {
  return value
    .replace(JWT, REDACTED)
    .replace(BEARER, (_match, name: string, gap: string) => `${name}${gap}${REDACTED}`)
    .replace(NAMED_SECRET, (_match, name: string, gap: string) => `${name}${gap}${REDACTED}`)
    .replace(OPAQUE, REDACTED);
}
