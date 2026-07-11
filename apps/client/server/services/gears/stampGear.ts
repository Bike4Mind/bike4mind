import { gearStampRepository } from '@bike4mind/database';

/**
 * Gears - stamp keys for actions that leave no other queryable trace.
 * Everything else is DERIVED (see pages/api/gears/status.ts); add a key here
 * only when derivation is genuinely impossible.
 */
export type StampedGearKey =
  'downloadnotebook' | 'forknotebook' | 'websearch' | 'webfetch' | 'wolfram' | 'matheval' | 'clidocs';

/**
 * Fire-and-forget first-use stamp. Never awaited and never throws - a
 * progression stamp must not break (or slow) the feature it decorates.
 * Idempotent via the (userId, key) unique index; repeat stamps are no-ops.
 */
export function stampGear(userId: string | undefined | null, key: StampedGearKey): void {
  if (!userId) return;
  void gearStampRepository.stamp(String(userId), key).catch(() => undefined);
}
