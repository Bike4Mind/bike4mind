import { adminUserRiskFlagsSchema, ApiKeyScope, CreditHolderType } from '@bike4mind/common';
import { creditTransactionRepository, imageModerationIncidentRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { respond } from '@server/utils/respond';
import { evaluateUserRisk } from '@server/utils/userRiskFlags';
import { listUserSignIns } from '@server/utils/userSignIns';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const SIGN_IN_LIMIT = 200;
const MODERATION_LIMIT = 50;

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
  const [signIns, successSignIns, spend, moderationIncidents] = await Promise.all([
    listUserSignIns(user.id, loginRecords, { limit: SIGN_IN_LIMIT }),
    // Separate success-only read so a burst of failed rows cannot push the earlier successes out of the page.
    listUserSignIns(user.id, loginRecords, { limit: SIGN_IN_LIMIT, successOnly: true }),
    creditTransactionRepository.summarizeAiSpend(user.id, CreditHolderType.User, now),
    imageModerationIncidentRepository.find(
      { userId: user.id, reviewStatus: { $ne: 'false_positive' } },
      { sort: { createdAt: -1 }, limit: MODERATION_LIMIT }
    ),
  ]);

  const seen = new Set(signIns.entries.map(e => e.id));
  const allSignIns = [...signIns.entries, ...successSignIns.entries.filter(e => !seen.has(e.id))];
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
