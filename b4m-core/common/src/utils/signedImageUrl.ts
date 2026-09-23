import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signs the image URLs `web_search` writes into its tool output, so `/api/search-image` (the
 * same-origin proxy that fetches them server-side) can verify a URL actually came from our own
 * search-provider results, not from a hostile page's snippet text steering the model into writing
 * an attacker-controlled URL with exfiltrated data in the query string.
 *
 * The signature is a trailing `&b4mSig=<hex>` (or `?b4mSig=<hex>` with no prior query string)
 * appended by plain string concatenation - never by reparsing the URL through `URLSearchParams`,
 * which re-serializes every existing param (e.g. turning a literal space into `+`) and would send
 * a byte-different URL to a host whose own signature (an imgix/S3-presigned link) covers the exact
 * query string the provider returned. Anchoring the signature to the END of the string, and
 * requiring it to be the only occurrence, is what makes verification unambiguous: anything a
 * tamperer appends after signing - including a second `b4mSig` - changes what's left of the anchor
 * match, which changes the canonical text, which invalidates the signature. There is deliberately
 * no "read the first/last `b4mSig` param and ignore the rest" step, since that step is exactly
 * where an earlier version of this file's bypass lived (verify read the URL's first `b4mSig` via
 * `searchParams.get` while signing canonicalized by deleting *every* `b4mSig`, so a validly-signed
 * URL with a second, attacker-authored `b4mSig` appended still verified, and was then forwarded to
 * `safeFetch` with that attacker data still attached).
 *
 * The model is already told to copy an `Images:` line's URL verbatim, so no new instruction is
 * needed for the signature to survive.
 *
 * The signature has no expiry: a stored reply, citable, published page, or curation transcript
 * persists indefinitely, and nothing re-signs a URL on read, so a TTL would make every card
 * permanently break once it lapsed rather than bound anything meaningful. What actually bounds
 * a leaked signed URL's usefulness is the same thing that bounds the route otherwise: it's only
 * reachable at all behind `jwtOnly` auth (apps/client/pages/api/search-image.ts) and is capped by
 * a per-user rate limit there.
 */

const SIGNATURE_PARAM = 'b4mSig';
// 32 lowercase hex chars - see computeSignature. Anchored to the end of the string ($): a
// signature is only ever valid as the LAST thing in the URL, which is the only shape
// signImageUrl ever produces and the only shape that can't be trivially extended with attacker
// data past it.
const TRAILING_SIGNATURE_RE = new RegExp(`[?&]${SIGNATURE_PARAM}=([0-9a-f]{32})$`);

// The SST secret's own declared default (infra/secrets.ts) - public in this repo, so a deploy
// that never overrode it must be treated the same as "no secret configured", not as a working key.
const KNOWN_PLACEHOLDER_SECRETS = new Set(['', 'my-secret-placeholder-value', 'not-configured']);

/**
 * True for an empty or known-placeholder signing secret. Shared so any caller that would
 * otherwise sign-and-fail (e.g. web_search deciding whether to pay for image results at all)
 * uses the same definition `verifyImageUrlSignature` fails closed on, rather than a second one
 * that could drift out of sync.
 */
export function isPlaceholderImageSigningSecret(secret: string | undefined): boolean {
  return KNOWN_PLACEHOLDER_SECRETS.has(secret ?? '');
}

function computeSignature(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 32);
}

/**
 * Appends expiry + signature query params by string concatenation (never reparses or
 * re-serializes the existing query string - see the file-level comment). Returns the URL
 * unchanged if it fails to parse as a URL, or if it already carries a trailing signature.
 */
export function signImageUrl(rawUrl: string, secret: string): string {
  try {
    // Validate-only: `new URL` is never used to reconstruct the string that gets signed or
    // returned, so existing query-string encoding is preserved byte for byte.
    new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (TRAILING_SIGNATURE_RE.test(rawUrl)) return rawUrl;
  const separator = rawUrl.includes('?') ? '&' : '?';
  const signature = computeSignature(rawUrl, secret);
  return `${rawUrl}${separator}${SIGNATURE_PARAM}=${signature}`;
}

/** The URL with its trailing signature removed, or the URL unchanged if it has none. Used to hand
 *  the upstream fetch the exact URL the provider returned, without the app's own query param. */
export function stripImageUrlSignature(signedUrl: string): string {
  const match = TRAILING_SIGNATURE_RE.exec(signedUrl);
  return match ? signedUrl.slice(0, match.index) : signedUrl;
}

/**
 * True only for a URL carrying exactly one, trailing signature that verifies against `secret`.
 * Always false when `secret` is empty or a known placeholder value (an unconfigured
 * SECRET_ENCRYPTION_KEY must never make every signature accept-anything, which is what hashing
 * with an empty/well-known key would otherwise produce).
 */
export function verifyImageUrlSignature(signedUrl: string, secret: string): boolean {
  if (isPlaceholderImageSigningSecret(secret)) return false;

  const match = TRAILING_SIGNATURE_RE.exec(signedUrl);
  if (!match) return false;

  const [, signature] = match;
  const canonical = signedUrl.slice(0, match.index);
  const expected = computeSignature(canonical, secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  // Both are fixed-length hex from the regex/computeSignature, but timingSafeEqual throws on a
  // length mismatch rather than returning false, so guard it explicitly anyway.
  if (signatureBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(signatureBuf, expectedBuf);
}
