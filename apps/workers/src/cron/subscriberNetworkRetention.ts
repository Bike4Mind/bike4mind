import { Logger } from '@bike4mind/observability';
import { SUBSCRIBER_NETWORK_RETENTION_DAYS } from '@bike4mind/common';
import { subscriberRepository } from '@bike4mind/database';

const RETENTION_MS = SUBSCRIBER_NETWORK_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const retentionLogger = new Logger({ metadata: { service: 'subscriberNetworkRetention' } });

/**
 * Clear the network captured on waitlist signups once it is older than the retention window. The
 * row itself stays: only signupNetwork goes. Runs inside the signup IP retention job (hosted cron
 * and self-host daily task), which already owns the same 90-day window for accounts.
 */
export async function runSubscriberNetworkRetention(options: { logger?: Logger; now?: Date } = {}) {
  const logger = options.logger ?? retentionLogger;
  const cutoff = new Date((options.now ?? new Date()).getTime() - RETENTION_MS);
  const clearedCount = await subscriberRepository.clearSignupNetworkBefore(cutoff);
  logger.log(
    `[SubscriberNetworkRetention] Cleared ${clearedCount} waitlist network records (cutoff: ${cutoff.toISOString()})`
  );
  return { clearedCount, cutoff: cutoff.toISOString() };
}
