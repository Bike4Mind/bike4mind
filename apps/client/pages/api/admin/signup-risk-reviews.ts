import {
  ApiKeyScope,
  SIGNUP_RISK_REVIEW_LIST_LIMIT,
  emailDomainOf,
  signupRiskReviewDecisionResultSchema,
  signupRiskReviewDecisionSchema,
  signupRiskReviewListSchema,
  type SignupRiskReviewItem,
  type SignupRiskReviewState,
} from '@bike4mind/common';
import { usageEventRepository, userApiKeyRepository, userRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
  userAuditTarget,
} from '@server/utils/adminAudit';
import { respond } from '@server/utils/respond';

// reopen is the undo of approve, offered by the admin tab's undo toast.
const TRANSITIONS = {
  approve: {
    from: 'pending',
    to: 'approved',
    action: 'user.signup_risk.approved',
    summary: 'approved a flagged signup',
  },
  reopen: {
    from: 'approved',
    to: 'pending',
    action: 'user.signup_risk.reopened',
    summary: 'reopened a signup risk review',
  },
} as const satisfies Record<
  string,
  { from: SignupRiskReviewState; to: SignupRiskReviewState; action: string; summary: string }
>;

const domainOf = (email: string | null | undefined) => {
  const domain = email ? emailDomainOf(email) : null;
  return domain ? (registrableDomain(domain) ?? domain) : null;
};

/**
 * The signup risk review queue (admin Risk review tab). GET lists pending accounts with what a
 * reviewer needs to decide; POST approves them (or reopens an approval), one audited transaction
 * per user. Suspending goes through the bulk abuse response routes instead (admin/abuse/bulk-*).
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .get(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const users = await userRepository.findPendingRiskReviews(SIGNUP_RISK_REVIEW_LIST_LIMIT + 1);
      const listed = users.slice(0, SIGNUP_RISK_REVIEW_LIST_LIMIT);
      const ids = listed.map(user => user.id);
      const [creditsSpent, apiKeysCreated] = await Promise.all([
        usageEventRepository.creditsSpentByUsers(ids),
        userApiKeyRepository.countCreatedByUserIds(ids),
      ]);
      const data = listed.flatMap((user): SignupRiskReviewItem[] =>
        user.riskScore
          ? [
              {
                userId: user.id,
                email: user.email ?? null,
                username: user.username ?? null,
                domain: domainOf(user.email),
                createdAt: user.createdAt,
                score: user.riskScore.score,
                signals: user.riskScore.signals,
                computedAt: user.riskScore.computedAt,
                creditsSpent: creditsSpent[user.id] ?? 0,
                apiKeysCreated: apiKeysCreated[user.id] ?? 0,
              },
            ]
          : []
      );
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, signupRiskReviewListSchema, { data, truncated: users.length > SIGNUP_RISK_REVIEW_LIST_LIMIT });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const parsed = signupRiskReviewDecisionSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected approve or reopen and 1 to 200 user ids');
      const reason = parseAdminActionReason(parsed.data.reason);
      const transition = TRANSITIONS[parsed.data.action];
      const userIds = [...new Set(parsed.data.userIds)];

      const self = userIds.find(userId => isSelfOrImpersonator(req.user, userId));
      if (self) {
        await denySelfAdminAction(req, {
          action: 'user.signup_risk.denied',
          attempted: transition.action,
          target: await userAuditTarget(self),
          message: 'Admins cannot review their own account.',
        });
      }

      const updatedUserIds: string[] = [];
      const skippedUserIds: string[] = [];
      const failedUserIds: string[] = [];
      for (const userId of userIds) {
        try {
          // A strict audit entry rides in the same transaction, so an unrecorded decision rolls back.
          const moved = await withTransaction(async () => {
            if (!(await userRepository.setRiskReviewState(userId, transition.from, transition.to))) return false;
            await recordAdminActionFromRequest(req, {
              action: transition.action,
              target: await userAuditTarget(userId),
              summary: transition.summary,
              reason,
              changes: [{ field: 'riskScore.reviewState', before: transition.from, after: transition.to }],
            });
            return true;
          });
          (moved ? updatedUserIds : skippedUserIds).push(userId);
        } catch (error) {
          req.logger.error('Signup risk review decision failed for user', { userId, error });
          failedUserIds.push(userId);
        }
      }
      respond(res, signupRiskReviewDecisionResultSchema, { updatedUserIds, skippedUserIds, failedUserIds });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
