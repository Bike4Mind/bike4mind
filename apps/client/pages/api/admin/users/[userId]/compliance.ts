import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, imageModerationIncidentRepository, userAuthAuditLogRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { CURRENT_POLICY_VERSION, type UserComplianceResponse } from '@bike4mind/common';

interface RequestQuery {
  userId: string;
}

// One-shot with a fixed cap on both audit trails; add cursor paging only if a real user's
// history ever exceeds it. Not a query param - nothing calls this with a page size.
const ROW_LIMIT = 50;

// Admin-only read-only endpoint aggregating a user's compliance evidence.
const handler = baseApi({ auth: true }).get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId } = req.query as RequestQuery;
    if (typeof userId !== 'string' || !userId) {
      throw new BadRequestError('Invalid user ID');
    }

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new BadRequestError('User not found');
    }

    const [moderationIncidents, recentAuthEvents] = await Promise.all([
      imageModerationIncidentRepository.find({ userId }, { sort: { createdAt: -1 }, limit: ROW_LIMIT }),
      userAuthAuditLogRepository.findByUser(userId, ROW_LIMIT),
    ]);

    const payload: UserComplianceResponse = {
      aupAcceptedVersion: user.aupAcceptedVersion ?? null,
      // Serialize dates to ISO strings so the wire type is honestly `string` (JSON has no Date).
      aupAcceptedAt: user.aupAcceptedAt ? new Date(user.aupAcceptedAt).toISOString() : null,
      ageAttestedAdult: user.ageAttestedAdult ?? null,
      currentPolicyVersion: CURRENT_POLICY_VERSION,
      isCurrent: user.aupAcceptedVersion === CURRENT_POLICY_VERSION,
      moderationIncidents: moderationIncidents.map(i => ({
        labels: i.labels,
        provider: i.provider,
        model: i.model,
        createdAt: i.createdAt ? new Date(i.createdAt).toISOString() : '',
      })),
      flags: {
        isBanned: !!user.isBanned,
        isModerated: !!user.isModerated,
        disputePending: !!user.disputePending,
      },
      recentAuthEvents: recentAuthEvents.map(e => ({
        event: e.event,
        actorIp: e.actorIp,
        userAgent: e.userAgent,
        createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : '',
      })),
    };

    return res.json(payload);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
