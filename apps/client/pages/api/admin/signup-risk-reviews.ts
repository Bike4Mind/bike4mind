import {
  ApiKeyScope,
  SIGNUP_RISK_REVIEW_LIST_LIMIT,
  SignupRiskScoringSchema,
  emailDomainOf,
  signupRiskReviewDecisionResultSchema,
  signupRiskReviewDecisionSchema,
  signupRiskReviewListSchema,
  type SignupRiskReviewItem,
  type SignupRiskReviewState,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  usageEventRepository,
  userApiKeyRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { releaseRiskReviewedSignupGrant } from '@server/credits/riskReviewGrantRelease';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
  userAuditTarget,
} from '@server/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const SIGNUP_RISK_REVIEWS_RATE_LIMIT = 30;

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
 * per user. Approving also pays a signup tranche the signup grant policy withheld, which reopening
 * does not take back. Suspending goes through the bulk abuse response routes instead (admin/abuse/bulk-*).
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(
    rateLimit({ limit: SIGNUP_RISK_REVIEWS_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-signup-risk-reviews' })
  )
  .get(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const users = await userRepository.findPendingRiskReviews(SIGNUP_RISK_REVIEW_LIST_LIMIT + 1);
      const listed = users.slice(0, SIGNUP_RISK_REVIEW_LIST_LIMIT);
      const ids = listed.map(user => user.id);
      const [creditsSpent, apiKeysCreated, settings] = await Promise.all([
        usageEventRepository.creditsSpentByUsers(ids),
        userApiKeyRepository.countCreatedByUserIds(ids),
        getSettingsMap({ adminSettings: adminSettingsRepository }),
      ]);
      const { reviewThreshold } = getSettingsValue('signupRiskScoring', settings, SignupRiskScoringSchema.parse({}));
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
                grantHeld: userService.isSignupGrantHeldForReview(user),
              },
            ]
          : []
      );
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, signupRiskReviewListSchema, {
        data,
        truncated: users.length > SIGNUP_RISK_REVIEW_LIST_LIMIT,
        reviewThreshold,
      });
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
      const grantReleasedUserIds: string[] = [];
      for (const userId of userIds) {
        try {
          // Pay before approving: a failed payout leaves the account pending, so the admin can retry it
          // from this queue. A retry after a paid-but-unapproved attempt finds nothing held.
          if (parsed.data.action === 'approve') {
            const credits = await releaseRiskReviewedSignupGrant(userId, {
              reason,
              audit: async ({ credits, creditTransactionId }) => {
                await recordAdminActionFromRequest(req, {
                  action: 'user.credits.adjusted',
                  target: await userAuditTarget(userId),
                  summary: 'released a signup grant held for risk review',
                  reason,
                  details: { credits, source: 'signup_unlock' },
                  related: creditTransactionId ? { creditTransactionId } : undefined,
                });
              },
            });
            if (credits > 0) grantReleasedUserIds.push(userId);
          }
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
      respond(res, signupRiskReviewDecisionResultSchema, {
        updatedUserIds,
        skippedUserIds,
        failedUserIds,
        grantReleasedUserIds,
      });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
