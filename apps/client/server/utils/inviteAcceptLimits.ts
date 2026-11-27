import { cacheRepository } from '@bike4mind/database';
import { TooManyRequestsError } from '@bike4mind/utils';
import { MAX_BULK_ITEMS } from '@bike4mind/common';

// An abuse throttle on accept attempts, refused or not; MAX_BULK_ITEMS + 20 fits one full bulk
// accept plus retries. Share-link tokens are 32 random bytes, so guessing is not what this bounds.
const INVITE_ACCEPTS_PER_HOUR = MAX_BULK_ITEMS + 20;
const HOUR_MS = 60 * 60 * 1000;

const acceptBudgetKey = (userId: string) => `rate-limit:${userId}:invite-accepts`;

/** Charges one accept attempt to the user's hourly window; throws 429 once it is spent. */
export async function reserveInviteAccept(userId: string): Promise<void> {
  const { success } = await cacheRepository.tryAddWithinLimitFixedWindow(
    acceptBudgetKey(userId),
    1,
    INVITE_ACCEPTS_PER_HOUR,
    HOUR_MS
  );
  if (!success) throw new TooManyRequestsError('Too many invite accepts. Try again later.');
}
