import { adminUserRiskFlagsSchema, ApiKeyScope, CreditHolderType } from '@bike4mind/common';
import { creditTransactionRepository, imageModerationIncidentRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { respond } from '@server/utils/respond';
import { evaluateUserRisk, RISK_RULE_CONFIG } from '@server/utils/userRiskFlags';
import { listUserSignIns } from '@server/utils/userSignIns';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const SIGN_IN_LIMIT = 200;
const MODERATION_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
// Highest possible ObjectId, so a cursor at an instant includes every row at that instant.
const MAX_OBJECT_ID = 'f'.repeat(24);

/**
 * Rule-based risk flags for one user. JWT-only: the evidence includes IP addresses, so an API key must
 * never reach it.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const { userId } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const now = new Date();
  const loginRecords = user.loginRecords ?? [];
  const newSignInWindowStart = new Date(now.getTime() - RISK_RULE_CONFIG.newSignIn.windowDays * DAY_MS);
  const [signIns, recentSuccesses, priorSuccesses, spend, moderationIncidents] = await Promise.all([
    listUserSignIns(user.id, loginRecords, { limit: SIGN_IN_LIMIT }),
    // Success-only reads, split at the new-sign-in window, so neither failed rows nor a burst of recent
    // successes can push the earlier successes the new IP/device rule compares against out of the page.
    listUserSignIns(user.id, loginRecords, { limit: SIGN_IN_LIMIT, successOnly: true }),
    listUserSignIns(user.id, loginRecords, {
      limit: SIGN_IN_LIMIT,
      successOnly: true,
      cursor: { occurredAt: newSignInWindowStart, id: MAX_OBJECT_ID },
    }),
    creditTransactionRepository.summarizeAiSpend(user.id, CreditHolderType.User, now),
    imageModerationIncidentRepository.find(
      { userId: user.id, reviewStatus: { $ne: 'false_positive' } },
      { sort: { createdAt: -1 }, limit: MODERATION_LIMIT }
    ),
  ]);

  const allSignIns = [
    ...new Map(
      [...signIns.entries, ...recentSuccesses.entries, ...priorSuccesses.entries].map(e => [e.id, e])
    ).values(),
  ];
  const flags = evaluateUserRisk({ signIns: allSignIns, dailyCredits: spend.dailyCredits, moderationIncidents }, now);

  Logger.info('[Admin] Evaluated user risk flags', { count: flags.length });
  return respond(res, adminUserRiskFlagsSchema, { flags });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
