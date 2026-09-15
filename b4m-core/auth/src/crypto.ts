import crypto from 'crypto';

/**
 * Constant-time token comparison (via `crypto.timingSafeEqual`) to prevent timing
 * attacks that guess a token character by character.
 *
 * @param a - First token to compare
 * @param b - Second token to compare
 * @returns true if tokens match, false otherwise
 *
 * @security Returns false if either token is empty (a valid token is never empty,
 * so `safeCompareTokens('', '')` is false) or if lengths differ. Comparison errors
 * are caught and return false.
 */
export function safeCompareTokens(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  try {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
