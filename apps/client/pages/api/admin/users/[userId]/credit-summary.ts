import {
  adminCreditSummarySchema,
  BadRequestError,
  CreditHolderType,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';
import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { zeroFilledDailySpend } from '@server/utils/adminCreditSummary';
import { respond } from '@server/utils/respond';

/**
 * GET /api/admin/users/[userId]/credit-summary
 *
 * Balance, AI spend over rolling 24h/7d/30d, the 30-day top model, the last completed top-up and a
 * 90-day zero-filled daily spend series. Spend counts AI usage rows only (never transfers or
 * expiries), as magnitudes.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

    const { userId } = req.query as { userId?: string | string[] };
    if (typeof userId !== 'string' || !userId) throw new BadRequestError('Invalid user ID');

    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const now = new Date();
    const [spend, topUp] = await Promise.all([
      creditTransactionRepository.summarizeAiSpend(user.id, CreditHolderType.User, now),
      creditTransactionRepository.findLatestTopUp(user.id, CreditHolderType.User),
    ]);

    return respond(res, adminCreditSummarySchema, {
      balance: user.currentCredits,
      spent: spend.spent,
      topModel30d: spend.topModel30d,
      lastTopUp:
        topUp && (topUp.type === 'purchase' || topUp.type === 'subscription')
          ? { at: topUp.createdAt.toISOString(), credits: Math.abs(topUp.credits), type: topUp.type }
          : null,
      daily: zeroFilledDailySpend(spend.dailyCredits, now),
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
