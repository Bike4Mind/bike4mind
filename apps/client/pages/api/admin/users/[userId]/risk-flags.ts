import { adminUserRiskFlagsSchema, ApiKeyScope, CreditHolderType } from '@bike4mind/common';
import { creditTransactionRepository, ImageModerationIncident, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { respond } from '@server/utils/respond';
import { evaluateUserRisk, RISK_RULE_CONFIG, type RiskModerationIncident } from '@server/utils/userRiskFlags';
import { listUserRiskSignIns } from '@server/utils/userSignIns';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const QUERY_MAX_TIME_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const listModerationIncidents = async (userId: string, now: Date): Promise<RiskModerationIncident[]> => {
  const cursor = ImageModerationIncident.find({
    userId,
    reviewStatus: { $ne: 'false_positive' },
    createdAt: { $gte: new Date(now.getTime() - RISK_RULE_CONFIG.moderation.windowDays * DAY_MS), $lte: now },
  })
    .select('createdAt labels.name reviewStatus')
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<RiskModerationIncident>()
    .cursor({ batchSize: 200 });
  const incidents: RiskModerationIncident[] = [];
  try {
    for await (const incident of cursor) incidents.push(incident);
  } finally {
    await cursor.close();
  }
  return incidents;
};

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
  const [signIns, spend, moderationIncidents] = await Promise.all([
    listUserRiskSignIns(user.id, loginRecords, now, RISK_RULE_CONFIG.failedSignIns.windowHours),
    creditTransactionRepository.summarizeAiSpend(user.id, CreditHolderType.User, now),
    listModerationIncidents(user.id, now),
  ]);

  const flags = evaluateUserRisk({ signIns, dailyCredits: spend.dailyCredits, moderationIncidents }, now);

  Logger.info('[Admin] Evaluated user risk flags', { count: flags.length });
  return respond(res, adminUserRiskFlagsSchema, { flags });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
