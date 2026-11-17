import { cacheRepository, withTransaction } from '@bike4mind/database';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { deliveryMailbox } from '@bike4mind/server-utils/utils/deliveryMailbox';
import { otcEmailKey } from './otcLimits';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Mails one inbox may receive from user-chosen sends, across all senders. */
export const RECIPIENT_SEND_WINDOWS = [
  { name: 'hourly', limit: 5, windowMs: HOUR_MS },
  { name: 'daily', limit: 10, windowMs: DAY_MS },
] as const;

/** Keyed on the hashed delivery mailbox so plus-tags and Gmail dots share one budget and no raw address is stored. */
const keyOf = (mailboxKey: string, name: string) => `recipient-send-limit:${name}:${mailboxKey}`;

const retryAfterOf = (expiresAt: Date, windowMs: number, now: number): number => {
  const timeLeftMs = expiresAt.getTime() - now;
  return Math.max(1, Math.ceil((timeLeftMs > 0 ? timeLeftMs : windowMs) / 1000));
};

class RecipientAdmissionRefused extends Error {
  constructor(readonly retryAfter: number) {
    super('Recipient send budget exhausted');
    this.name = 'RecipientAdmissionRefused';
  }
}

/**
 * Spends one unit of every window for each distinct inbox among `recipients`, or none: when any inbox
 * is over a window the whole send is refused with Retry-After seconds. All checks and charges
 * commit together; a refused admission or failed write spends no recipient budget.
 */
export async function reserveRecipientSendBudget(
  recipients: readonly string[],
  now: number = Date.now()
): Promise<{ retryAfter: number } | undefined> {
  if (isE2EEnabled()) return undefined;
  const mailboxKeys = Array.from(new Set(recipients.map(recipient => otcEmailKey(deliveryMailbox(recipient))))).sort();
  if (mailboxKeys.length === 0) return undefined;

  try {
    await withTransaction(async () => {
      for (const mailboxKey of mailboxKeys) {
        for (const { name, limit, windowMs } of RECIPIENT_SEND_WINDOWS) {
          const { count, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(
            keyOf(mailboxKey, name),
            0,
            limit,
            windowMs
          );
          if (count >= limit) throw new RecipientAdmissionRefused(retryAfterOf(expiresAt, windowMs, now));
        }
      }

      for (const mailboxKey of mailboxKeys) {
        for (const { name, limit, windowMs } of RECIPIENT_SEND_WINDOWS) {
          const { success, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(
            keyOf(mailboxKey, name),
            1,
            limit,
            windowMs
          );
          if (!success) throw new RecipientAdmissionRefused(retryAfterOf(expiresAt, windowMs, now));
        }
      }
    });
  } catch (error: unknown) {
    if (error instanceof RecipientAdmissionRefused) return { retryAfter: error.retryAfter };
    throw error;
  }
  return undefined;
}
