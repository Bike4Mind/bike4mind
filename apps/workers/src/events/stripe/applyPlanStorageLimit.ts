import { MAX_STORAGE_LIMIT_MB } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type Stripe from 'stripe';

/** Stripe price metadata key carrying the plan's storage allowance, in decimal MB (see BYTES_PER_STORAGE_MB). */
export const STORAGE_LIMIT_PRICE_METADATA_KEY = 'storageLimitMb';

export type PlanStorageLimitReading =
  { kind: 'absent' } | { kind: 'invalid'; raw: string } | { kind: 'limit'; limitMb: number };

const WHOLE_NUMBER = /^\d+$/;

export const readPlanStorageLimit = (priceMetadata: Stripe.Metadata | null | undefined): PlanStorageLimitReading => {
  const raw = priceMetadata?.[STORAGE_LIMIT_PRICE_METADATA_KEY];
  if (raw === undefined) return { kind: 'absent' };
  const trimmed = raw.trim();
  const limitMb = Number(trimmed);
  if (!WHOLE_NUMBER.test(trimmed) || limitMb <= 0 || limitMb > MAX_STORAGE_LIMIT_MB) return { kind: 'invalid', raw };
  return { kind: 'limit', limitMb };
};

/**
 * Writes the subscribed price's `storageLimitMb` to the owner's `planStorageLimit`. A price without the
 * key, or with an unusable value, leaves the limit as it is. Cancellation does not reset it. Never throws:
 * a storage-limit failure must not fail the subscription sync that already committed.
 */
export async function applyPlanStorageLimit(
  subscription: Stripe.Subscription,
  userId: string,
  logger: Logger
): Promise<void> {
  const price = subscription.items.data[0]?.price;
  const reading = readPlanStorageLimit(price?.metadata);
  if (reading.kind === 'absent') return;
  if (reading.kind === 'invalid') {
    logger.warn(`Ignoring invalid ${STORAGE_LIMIT_PRICE_METADATA_KEY} on price ${price?.id}`, { raw: reading.raw });
    return;
  }
  try {
    const applied = await userRepository.setPlanStorageLimit(userId, reading.limitMb);
    if (applied) {
      logger.info(`Set plan storage limit for user ${userId} to ${reading.limitMb} MB from price ${price?.id}`);
    } else {
      logger.warn(`Plan storage limit not applied: no migrated user ${userId} for subscription ${subscription.id}`);
    }
  } catch (error) {
    logger.error(`Failed to apply plan storage limit for user ${userId}`, { error });
  }
}
