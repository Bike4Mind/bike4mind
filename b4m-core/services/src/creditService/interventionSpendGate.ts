import {
  ForbiddenError,
  insufficientCreditsError,
  isActiveInterventionHold,
  type ICacheRepository,
  type InterventionHold,
  type IUserDocument,
  type IUserRepository,
} from '@bike4mind/common';

import { interventionHoldMessage } from '../userService/accountState';

const HOUR_MS = 60 * 60 * 1000;

export type InterventionSpendWindow = Pick<ICacheRepository, 'tryAddWithinLimitFixedWindow'>;

const activeHolds = (user: Pick<IUserDocument, 'interventionHolds'>, now: Date): InterventionHold[] =>
  (user.interventionHolds ?? []).filter(hold => isActiveInterventionHold(hold, now));

/**
 * Admits AI spend against the user's graduated intervention holds. Credit-hold admission sites call it
 * AFTER their balance debit and undo the debit when it throws, so a hold committed before the debit
 * is always seen, however late it lands after the caller's first user read; the agent executor's
 * per-iteration gate meters each iteration's estimate before it runs. Throws 403 for an
 * active verify/review hold, 422 insufficient_credits once a limit hold's hourly credits are spent.
 * A limit hold with no window adapter wired refuses rather than admitting unmetered spend.
 */
export async function assertInterventionSpendAllowed(
  params: { userId: string; credits: number; now?: Date },
  adapters: { users: Pick<IUserRepository, 'findById'>; window?: InterventionSpendWindow }
): Promise<void> {
  const now = params.now ?? new Date();
  const user = await adapters.users.findById(params.userId);
  if (!user) return;
  const refusal = interventionHoldMessage(user, now);
  if (refusal) throw new ForbiddenError(refusal);
  const limits = activeHolds(user, now).filter(hold => hold.tier === 'limit');
  if (limits.length === 0) return;
  const creditsPerHour = Math.min(...limits.map(hold => hold.creditsPerHour ?? 0));
  const admitted =
    adapters.window &&
    (
      await adapters.window.tryAddWithinLimitFixedWindow(
        `intervention:spend:${params.userId}`,
        Math.ceil(params.credits),
        creditsPerHour,
        HOUR_MS,
        { outsideTransaction: true }
      )
    ).success;
  if (!admitted)
    throw insufficientCreditsError(
      `This account's AI spend is limited to ${creditsPerHour} credits per hour for now. Try again after the hour resets, or contact support.`
    );
}
