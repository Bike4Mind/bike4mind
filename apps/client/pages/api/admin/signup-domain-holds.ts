import { respond } from '@server/utils/respond';
import { z } from 'zod';
import { ApiKeyScope, PENDING_FREE_CREDITS_TAG, signupDomainReviewSchema } from '@bike4mind/common';
import {
  disposableDomainRepository,
  DomainIntelligenceModel,
  SignupDomainReviewModel,
  User,
} from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { isEligibleForFreeCredits, releaseVerifiedPendingFreeCredits } from '@server/auth/emailVerifiedGrants';

const decisionSchema = z.object({
  domain: z.string().min(1).max(253),
  action: z.enum(['confirm', 'release']),
  afterUserId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
});

const sourceStatusSchema = z.object({
  source: z.string(),
  count: z.number(),
  lastSuccessAt: z.date().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.date().optional(),
});

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .get(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const parsed = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('Invalid page');
      const limit = 25;
      const [data, total, sources, intelCacheSize] = await Promise.all([
        SignupDomainReviewModel.find()
          .sort({ triggeredAt: -1, _id: -1 })
          .skip((parsed.data.page - 1) * limit)
          .limit(limit)
          .lean(),
        SignupDomainReviewModel.countDocuments(),
        disposableDomainRepository.getDisposableSourceStatus(),
        DomainIntelligenceModel.estimatedDocumentCount(),
      ]);
      respond(
        res,
        z.object({
          data: z.array(signupDomainReviewSchema),
          total: z.number(),
          sources: z.array(sourceStatusSchema),
          intelCacheSize: z.number(),
        }),
        { data, total, sources, intelCacheSize }
      );
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      ensureAdmin(req.user?.isAdmin);
      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a domain and confirm/release action');
      const { domain, action, afterUserId } = parsed.data;
      const status = action === 'release' ? 'released' : 'blocked';
      const review = await SignupDomainReviewModel.findOneAndUpdate(
        {
          domain,
          status: {
            $in:
              action === 'release'
                ? ['held_pending_review', 'blocked', 'released']
                : ['held_pending_review', 'blocked'],
          },
        },
        { $set: { status, reviewedBy: req.user.id, reviewedAt: new Date() } },
        { new: true }
      );
      if (!review) throw new BadRequestError('Hold not found or already resolved with another decision');
      let creditsReleased = 0;
      let remaining = 0;
      let nextCursor: string | null = null;
      if (action === 'release') {
        // Include accounts created after the hold as well as the original cohort. Never re-tag
        // already credited users: only the existing pending breadcrumb is eligible for recovery.
        const pendingQuery = {
          emailVerified: true,
          tags: PENDING_FREE_CREDITS_TAG,
          email: { $regex: `@(?:[^@]+\\.)?${escapeRegex(domain)}\\.*$`, $options: 'i' },
        };
        const users = await User.find({ ...pendingQuery, ...(afterUserId ? { _id: { $gt: afterUserId } } : {}) })
          .sort({ _id: 1 })
          .limit(100);
        if (users.length === 100) nextCursor = String(users[users.length - 1]._id);
        let stillPending = 0;
        for (const user of users) {
          // Releasing a hold never overrides the disposable/blocked-domain gate; those users stay pending.
          if (!user.email || !(await isEligibleForFreeCredits(user.email, req.logger))) {
            stillPending++;
            continue;
          }
          const result = await releaseVerifiedPendingFreeCredits(
            { id: String(user._id), tags: user.tags, pendingCreditGrant: user.pendingCreditGrant },
            'Signup domain hold released by admin',
            req.logger,
            undefined,
            { bypassBudget: true }
          );
          creditsReleased += result.creditsGranted;
          if (!result.tags) stillPending++;
        }
        // The regex cannot use an index, so recount only when this request did not see every candidate.
        remaining = afterUserId || nextCursor ? await User.countDocuments(pendingQuery) : stillPending;
      }
      res.status(200).json({ status, creditsReleased, remaining, nextCursor });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
