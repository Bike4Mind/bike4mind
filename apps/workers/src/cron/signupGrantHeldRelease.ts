/**
 * Pays free signup grants held by the daily budget, oldest first, against the new day's budget, then
 * the payment unlocks whose settling window has passed (userService.releaseDueHeldUnlocks).
 * Schedule: hourly (infra/cron.ts signupGrantHeldRelease), so the day's first run drains the backlog.
 * Self-host equivalent: apps/workers/src/selfhost/signupGrantHeldRelease.ts.
 */
import { connectDB, signupGrantReleaseRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { buildHeldGrantAdapters } from '@server/credits/heldSignupGrantAdapters';

const logger = new Logger({ metadata: { service: 'signupGrantHeldRelease' } });
const MAX_USERS_PER_RUN = 500;

export async function runSignupGrantHeldRelease(
  now: Date = new Date()
): Promise<userService.HeldReleaseCronResult & { heldUnlocks: userService.HeldUnlockReleaseResult }> {
  const adapters = buildHeldGrantAdapters(logger);
  const result = await userService.releaseHeldGrantsAgainstBudget(
    {
      ...adapters,
      listHeldIds: async input =>
        (await signupGrantReleaseRepository.listHeld({ ...input, reason: 'budget_exhausted', payableOnly: true })).map(
          row => row.id
        ),
    },
    { maxUsers: MAX_USERS_PER_RUN }
  );
  if (result.scanned > 0) logger.info('[signupGrantHeldRelease] done', result);
  const heldUnlocks = await userService.releaseDueHeldUnlocks(
    { ...adapters.grant, listDueIds: input => signupGrantReleaseRepository.listDueHeldUnlocks(input) },
    { now, maxUsers: MAX_USERS_PER_RUN }
  );
  if (heldUnlocks.scanned > 0) logger.info('[signupGrantHeldRelease] held unlocks done', heldUnlocks);
  return { ...result, heldUnlocks };
}

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runSignupGrantHeldRelease();
};
