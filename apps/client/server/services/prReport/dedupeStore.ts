/**
 * PR report generator - the send dedupe store.
 *
 * Backed by the shared Mongo `Cache` collection, which is reachable by every replica
 * and already carries a unique index on `key` plus a TTL index on `expiresAt`. An
 * in-process map would be a correctness trap here: it works in single-process dev and
 * a single-process test suite, then silently does nothing across Lambda invocations,
 * producing the exact double-post it was meant to prevent while the test still passes.
 *
 * Note this deliberately does NOT reuse `NotificationDeduplicator` from
 * `@bike4mind/utils`, which is precisely that in-process `Map`.
 *
 * Three primitives are required and all three are atomic at the database:
 *   - put-if-absent for the reserve (`claimDedup`)
 *   - compare-and-set for the flip (`casUpdateDedup`)
 *   - compare-and-delete for the release (`casDeleteDedup`)
 *
 * Put-if-absent alone is not enough. The TTL is set once at reserve, so a submit that
 * stalls past it can settle after a DIFFERENT submit reserved the same key; an
 * unconditional write would then destroy the new owner's reservation and re-open the
 * double-post.
 */

import { cacheRepository } from '@bike4mind/database';
import type { SendDedupeStore, SendReservation } from '@bike4mind/services';

/**
 * Every store call is bounded. The reserve is a precondition of posting, so a store
 * that hangs must surface as a refused send rather than an open request.
 */
const STORE_TIMEOUT_MS = 3_000;

const OWNER_FIELD = 'ownerToken';

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${STORE_TIMEOUT_MS}ms`)), STORE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Only a well-formed reservation counts; anything else is treated as absent. */
function toReservation(value: Record<string, unknown> | null | undefined): SendReservation | null {
  if (!value) return null;
  const state = value.state;
  const ownerToken = value[OWNER_FIELD];
  if ((state !== 'inFlight' && state !== 'delivered') || typeof ownerToken !== 'string') return null;
  return { state, ownerToken };
}

export function createSendDedupeStore(): SendDedupeStore {
  return {
    /**
     * Atomic put-if-absent. THROWS when the store cannot confirm the reserve - the
     * caller must then refuse the send rather than post unreserved.
     */
    async reserve(key, reservation, ttlMs) {
      const result = await withTimeout(cacheRepository.claimDedup(key, { ...reservation }, ttlMs), 'dedupe reserve');

      if (result.claimed) return { reserved: true };
      return { reserved: false, existing: toReservation(result.existingData) ?? undefined };
    },

    /**
     * Read an existing reservation. `null` means nobody holds the key - a third
     * answer, distinct from in-flight and delivered, and one the caller must not
     * collapse into either.
     */
    async read(key) {
      const value = await withTimeout(cacheRepository.readDedup(key), 'dedupe read');
      return toReservation(value);
    },

    /**
     * Flip to `delivered`, conditional on still owning the reservation.
     *
     * The TTL is deliberately not extended: the dedupe window should not slide just
     * because the state moved.
     */
    async markDelivered(key, ownerToken) {
      return withTimeout(
        cacheRepository.casUpdateDedup(key, OWNER_FIELD, ownerToken, {
          state: 'delivered',
          [OWNER_FIELD]: ownerToken,
        }),
        'dedupe markDelivered'
      );
    },

    /** Release, conditional on still owning it. Called ONLY on definite non-delivery. */
    async release(key, ownerToken) {
      return withTimeout(cacheRepository.casDeleteDedup(key, OWNER_FIELD, ownerToken), 'dedupe release');
    },
  };
}
