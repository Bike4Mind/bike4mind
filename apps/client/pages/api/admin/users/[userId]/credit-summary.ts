import {
  adminCreditSummarySchema,
  BadRequestError,
  CreditHolderType,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditTransactionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { isFreeTierCapUser, utcMidnight } from '@server/billing/freeTierDailyCapGate';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { zeroFilledDailySpend } from '@server/utils/adminCreditSummary';
import { respond } from '@server/utils/respond';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /api/admin/users/[userId]/credit-summary
 *
 * Balance, AI spend over rolling 24h/7d/30d, the 30-day top model, the last completed top-up, a
 * 90-day zero-filled daily spend series, and spend per model and per source over 7/30/90 UTC days.
 * Spend counts AI usage rows only (never transfers or expiries), as magnitudes. systemCost is the
 * provider USD of system-sourced work, read from usage events since that work often bills 0 credits.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

    const { userId } = req.query as { userId?: string | string[] };
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const now = new Date();
    const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const [spend, topUp, systemToday, system7d, system30d, settings] = await Promise.all([
      creditTransactionRepository.summarizeAiSpend(user.id, CreditHolderType.User, now),
      creditTransactionRepository.findLatestTopUp(user.id, CreditHolderType.User),
      usageEventRepository.systemCostUsdByUserSince(user.id, utcMidnight(now)),
      usageEventRepository.systemCostUsdByUserSince(user.id, daysAgo(7)),
      usageEventRepository.systemCostUsdByUserSince(user.id, daysAgo(30)),
      getSettingsMap({ adminSettings: adminSettingsRepository }),
    ]);

    const dailyCapUsd = getSettingsValue('freeTierDailySystemCostCapUsd', settings) ?? 0;
    // Mirrors the gate's exemptions so the card never flags a user the cap cannot refuse.
    // Org-billed turns are exempt per turn too, which a per-user summary cannot show.
    const capApplies =
      dailyCapUsd > 0 && getSettingsValue('enforceCredits', settings) === true && (await isFreeTierCapUser(user));

    return respond(res, adminCreditSummarySchema, {
      balance: user.currentCredits,
      spent: spend.spent,
      topModel30d: spend.topModel30d,
      lastTopUp:
        topUp && (topUp.type === 'purchase' || topUp.type === 'subscription')
          ? { at: topUp.createdAt.toISOString(), credits: Math.abs(topUp.credits), type: topUp.type }
          : null,
      daily: zeroFilledDailySpend(spend.dailyCredits, now),
      byModel: spend.byModel,
      bySource: spend.bySource,
      systemCost: {
        todayUsd: systemToday,
        last7dUsd: system7d,
        last30dUsd: system30d,
        dailyCapUsd,
        capApplies,
      },
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
