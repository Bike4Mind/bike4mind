/**
 * Module-singleton de-duplication for briefcase dispatches. A bounded seen-set
 * of nonces shared across all subscriber instances WITHIN THIS JS CONTEXT (i.e.
 * one browser tab), so a single dispatch is processed exactly once even when more
 * than one subscriber is mounted (e.g. an admin-embedded SessionContainer
 * alongside a route one) or the subscriber re-mounts on a session switch. It does
 * NOT span tabs - each tab has its own module instance; that's fine, since a
 * dispatch is only ever published within the tab that created it.
 *
 * Bounded MEANINGFULLY (last MAX nonces, or TTL_MS, whichever is larger) - a
 * set of size 1 would satisfy the letter but not the intent. Pure and DOM-free,
 * so the dispatch contract is testable without a browser.
 */

const TTL_MS = 60_000;
const MAX = 128;

const seen = new Map<string, number>(); // nonce -> first-seen timestamp

/**
 * Record a nonce and report whether it is fresh (not seen before). Returns false
 * for a duplicate. Evicts expired and over-cap entries on each call.
 */
export function isFreshNonce(nonce: string, now: number = Date.now()): boolean {
  for (const [key, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(key);
  }
  if (seen.has(nonce)) return false;
  seen.set(nonce, now);
  while (seen.size > MAX) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}

/** Test-only: clear the seen-set between cases. */
export function __resetDispatchDedup(): void {
  seen.clear();
}
