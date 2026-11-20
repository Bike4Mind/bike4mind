import { z } from 'zod';
import { adminSignupGrantPendingSummarySchema, BadRequestError, resolveSignupGrantSchedule } from '@bike4mind/common';
import {
  adminSettingsRepository,
  signupGrantBudgetRepository,
  signupGrantPendingRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { respond } from '@server/utils/respond';

const querySchema = z.object({ activeDays: z.coerce.number().int().min(1).max(90).default(7) });
const DAY_MS = 24 * 60 * 60 * 1000;

async function readTotals(activeDays: number, day: string) {
  const { dripCap, dailyCredits } = await resolveSignupGrantSchedule(adminSettingsRepository);
  const activeSince = new Date(Date.now() - activeDays * DAY_MS);
  return signupGrantPendingRepository.summarizePending({ dripCap, dailyCredits, day, activeSince });
}

async function readTrickle(day: string) {
  const [{ budget, missing }, spentToday] = await Promise.all([
    userService.resolvePoolBudget(adminSettingsRepository, 'trickle'),
    signupGrantBudgetRepository.getSpent(userService.signupGrantBudgetKey('trickle', day)),
  ]);
  return { day, spentToday, limit: budget, missing };
}

async function readQueue() {
  const { held, oldestHeldAt } = await signupGrantPendingRepository.heldQueue();
  return { held, oldestHeldAt: oldestHeldAt ? oldestHeldAt.toISOString() : null };
}

/**
 * GET /api/admin/signup-grants/pending-summary
 *
 * The Invite Center pending header: signup-grant exposure, recent activity, today's drip against the trickle
 * pool spend, and the held queue. `activeDays` (1-90, default 7) sets the activity window.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler(async (req, res) => {
    const query = querySchema.safeParse(req.query);
    if (!query.success) throw new BadRequestError('activeDays must be a whole number from 1 to 90');
    const { activeDays } = query.data;
    const day = userService.signupGrantBudgetDay();
    // One aggregation feeds exposure, activity and drip, so a failed read blanks those three tiles together.
    const [totals, trickle, queue] = await Promise.allSettled([
      readTotals(activeDays, day),
      readTrickle(day),
      readQueue(),
    ]);
    const settled = <T>(part: PromiseSettledResult<T>, name: string): T | null => {
      if (part.status === 'fulfilled') return part.value;
      req.logger.warn(`Pending summary: ${name} read failed`, { error: part.reason });
      return null;
    };
    const exposure = settled(totals, 'exposure');
    return respond(res, adminSignupGrantPendingSummarySchema, {
      exposure: exposure && {
        accountsWithRemaining: exposure.accountsWithRemaining,
        totalRemaining: exposure.totalRemaining,
        totalDripRemaining: exposure.totalDripRemaining,
      },
      activity: exposure && {
        days: activeDays,
        accounts: exposure.activeAccounts,
        remaining: exposure.activeRemaining,
      },
      drip: exposure && { day, committed: exposure.dripCommitToday, accounts: exposure.dripAccountsToday },
      trickle: settled(trickle, 'trickle'),
      queue: settled(queue, 'queue'),
    });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
