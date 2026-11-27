import { cacheRepository } from '@bike4mind/database';
import { otcLimitOf } from './otcLimits';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Limits on the public subscribe form (/api/subscribers/create). Real use is low-volume, so the
 * per-IP caps leave room for retries and a shared office NAT and nothing more. The Slack
 * cap is global because a many-source flood passes every per-IP cap; it only silences the channel,
 * signups are still saved.
 *
 * Each limit can be lowered, never raised, by its admin setting (SecOps > Subscriber Limits). Every
 * setting's `max` in settingsMap (b4m-core/common/src/schemas/settings.ts) must equal the limit here.
 */
export const SUBSCRIBER_LIMITS = {
  perIp: { limit: 5, windowMs: 15 * MINUTE_MS, setting: 'subscriberLimitPerIp' },
  perIpDaily: { limit: 10, windowMs: DAY_MS, setting: 'subscriberLimitPerIpDaily' },
  slackAlertsPerHour: { limit: 10, windowMs: HOUR_MS, setting: 'subscriberLimitSlackAlertsPerHour' },
} as const;

/**
 * How to announce one new subscriber: `post` under the hourly cap, `pause` exactly once when it is
 * first exceeded (the caller posts a single notice), then `skip` until the window resets.
 */
export async function reserveSubscriberAlert(): Promise<{ action: 'post' | 'pause' | 'skip'; resumesAt: Date }> {
  const window = SUBSCRIBER_LIMITS.slackAlertsPerHour;
  const limit = await otcLimitOf(window);
  // One slot past the limit is the pause notice itself.
  const { success, count, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    'subscriber-limit:slack-alerts',
    limit + 1,
    window.windowMs
  );
  if (!success) return { action: 'skip', resumesAt: expiresAt };
  return { action: count <= limit ? 'post' : 'pause', resumesAt: expiresAt };
}
