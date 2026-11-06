import { adminSignupGrantPendingSummarySchema, resolveSignupGrantSchedule } from '@bike4mind/common';
import {
  adminSettingsRepository,
  signupGrantBudgetRepository,
  signupGrantPendingRepository,
  signupGrantReleaseRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { respond } from '@server/utils/respond';

async function readTrickle() {
  const day = userService.signupGrantBudgetDay();
  const [{ budget, missing }, spentToday] = await Promise.all([
    userService.resolvePoolBudget(adminSettingsRepository, 'trickle'),
    signupGrantBudgetRepository.getSpent(userService.signupGrantBudgetKey('trickle', day)),
  ]);
  return { day, spentToday, limit: budget, missing };
}

async function readQueue() {
  const [held, oldest] = await Promise.all([
    signupGrantReleaseRepository.countHeld(),
    signupGrantPendingRepository.oldestHeldAt(),
  ]);
  return { held, oldestHeldAt: oldest ? oldest.toISOString() : null };
}

/**
 * GET /api/admin/signup-grants/pending-summary
 *
 * The Invite Center pending header: signup-grant exposure, today's trickle pool spend and the held queue.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler(async (req, res) => {
    const [exposure, trickle, queue] = await Promise.allSettled([
      resolveSignupGrantSchedule(adminSettingsRepository).then(({ dripCap }) =>
        signupGrantPendingRepository.summarizePending({ dripCap })
      ),
      readTrickle(),
      readQueue(),
    ]);
    const settled = <T>(part: PromiseSettledResult<T>, name: string): T | null => {
      if (part.status === 'fulfilled') return part.value;
      req.logger.warn(`Pending summary: ${name} read failed`, { error: part.reason });
      return null;
    };
    return respond(res, adminSignupGrantPendingSummarySchema, {
      exposure: settled(exposure, 'exposure'),
      trickle: settled(trickle, 'trickle'),
      queue: settled(queue, 'queue'),
    });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
