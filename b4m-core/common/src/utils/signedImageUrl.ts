import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signs the image URLs `web_search` writes into its tool output, so `/api/search-image` (the
 * same-origin proxy that fetches them server-side) can verify a URL actually came from our own
 * search-provider results, not from a hostile page's snippet text steering the model into writing
 * an attacker-controlled URL with exfiltrated data in the query string.
 *
 * The signature rides as a query param on the URL itself - the model is already told to copy an
 * `Images:` line's URL verbatim, so no new instruction is needed for the signature to survive.
 */

const SIGNATURE_PARAM = 'b4mSig';

function canonicalUrl(url: URL): string {
  const clone = new URL(url.toString());
  clone.searchParams.delete(SIGNATURE_PARAM);
  return clone.toString();
}

function computeSignature(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 32);
}

/** Appends a signature query param. Returns the URL unchanged if it fails to parse as a URL. */
export function signImageUrl(rawUrl: string, secret: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(SIGNATURE_PARAM, computeSignature(canonicalUrl(url), secret));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/** True only for a URL carrying a signature that verifies against `secret`. */
export function verifyImageUrlSignature(signedUrl: string, secret: string): boolean {
  let url: URL;
  try {
    url = new URL(signedUrl);
  } catch {
    return false;
  }
  const signature = url.searchParams.get(SIGNATURE_PARAM);
  if (!signature) return false;

  const expected = computeSignature(canonicalUrl(url), secret);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch rather than returning false.
  if (signatureBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(signatureBuf, expectedBuf);
}
