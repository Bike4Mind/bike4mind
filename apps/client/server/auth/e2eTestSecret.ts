import { timingSafeEqual } from 'crypto';
import { Resource } from 'sst';

const UNSET_SENTINEL = 'not-configured';

/**
 * Checks the `x-e2e-cleanup-secret` header sent to the /api/test/* endpoints against the
 * stage's E2E_CLEANUP_SECRET (SST secret, or the env var on stages that inject it).
 * Fails closed: an unset, empty or placeholder secret rejects every request.
 */
export function isValidE2eTestSecret(provided: unknown): boolean {
  const expected = Resource.E2E_CLEANUP_SECRET?.value || process.env.E2E_CLEANUP_SECRET;
  if (!expected || expected === UNSET_SENTINEL) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  // timingSafeEqual throws on unequal lengths, so compare byte lengths first.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}
