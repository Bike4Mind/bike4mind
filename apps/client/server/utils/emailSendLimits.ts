import { cacheRepository } from '@bike4mind/database';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A send costs one unit plus one per recipient, so wide sends use the budget faster. */
export const EMAIL_SEND_WINDOWS = [
  { name: 'hourly', units: 30, windowMs: HOUR_MS },
  { name: 'daily', units: 100, windowMs: DAY_MS },
] as const;

export const emailSendCost = (recipientCount: number): number => 1 + recipientCount;

const keyOf = (userId: string, name: string) => `email-send-limit:${name}:${userId}`;

const retryAfterOf = (expiresAt: Date, windowMs: number): number => {
  const timeLeftMs = expiresAt.getTime() - Date.now();
  return Math.max(1, Math.ceil((timeLeftMs > 0 ? timeLeftMs : windowMs) / 1000));
};

/**
 * Spends the cost from every window or none. Returns Retry-After seconds when any window cannot
 * cover it. The check and the charge are separate calls, so a concurrent burst can overshoot a
 * window by a few sends.
 */
export async function reserveEmailSendBudget(
  userId: string,
  recipientCount: number
): Promise<{ retryAfter: number } | undefined> {
  if (isE2EEnabled()) return undefined;
  const cost = emailSendCost(recipientCount);

  for (const { name, units, windowMs } of EMAIL_SEND_WINDOWS) {
    const { count, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(
      keyOf(userId, name),
      0,
      units,
      windowMs
    );
    if (count + cost > units) return { retryAfter: retryAfterOf(expiresAt, windowMs) };
  }

  for (const { name, units, windowMs } of EMAIL_SEND_WINDOWS) {
    const { success, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(
      keyOf(userId, name),
      cost,
      units,
      windowMs
    );
    if (!success) return { retryAfter: retryAfterOf(expiresAt, windowMs) };
  }
  return undefined;
}
