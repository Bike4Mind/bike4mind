/**
 * Device Auth Counter Reconciliation
 *
 * The live-pending counter in device/initiate drifts high when MongoDB's TTL monitor
 * deletes expired pending authorizations without going through device/verify. This
 * cron corrects the drift by reading the authoritative DB count and resetting the
 * cache document to match.
 *
 * The reset has a TOCTOU: initiates that land between the DB read and the cache
 * write are overwritten. This makes the counter momentarily conservative (lower than
 * actual), which is the safer direction. The next minute's run corrects it.
 *
 * Schedule: every 1 minute
 * Enabled: production + dev
 */

import { connectDB, cacheRepository, deviceAuthorizationRepository } from '@bike4mind/database';
import { LIVE_PENDING_COUNTER_KEY } from '@server/utils/oauth/deviceAuthHelpers';

export async function handler(): Promise<void> {
  await connectDB();

  const trueCount = await deviceAuthorizationRepository.countPendingAndUnexpired();

  // 30-minute TTL keeps the key alive between reconcile ticks even under no load.
  const expiresAt = new Date(Date.now() + 30 * 60_000);
  await cacheRepository.createOrUpdate({
    key: LIVE_PENDING_COUNTER_KEY,
    result: { count: trueCount },
    expiresAt,
  });
}
