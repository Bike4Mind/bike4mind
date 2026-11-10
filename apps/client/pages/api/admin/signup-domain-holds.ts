import { respond } from '@server/utils/respond';
import { z } from 'zod';
import {
  ApiKeyScope,
  MODERATION_PAGE_READ,
  canAccessAdmin,
  isFullAdmin,
  SIGNUP_DOMAIN_HOLD_REASON_FILTER_KEYS,
  SIGNUP_DOMAIN_HOLD_STATUS_FILTERS,
  signupDomainReviewSchema,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  disposableDomainRepository,
  DomainIntelligenceModel,
  signupDomainHoldListRepository,
  SignupDomainReviewModel,
  withTransaction,
} from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { adminApi, requireAdminPermission } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { releaseHeldSignupCredits } from '@server/security/signupDomainHoldAssessment/releaseHeldSignupCredits';
import { isSelfOrImpersonator, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const decisionSchema = z.object({
  domain: z.string().min(1).max(253),
  action: z.enum(['confirm', 'release']),
  afterUserId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
});

const PAGE_SIZE = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  // Pending by default: those are the rows that still need a decision.
  status: z.enum(SIGNUP_DOMAIN_HOLD_STATUS_FILTERS).default('pending'),
  reason: z.enum(SIGNUP_DOMAIN_HOLD_REASON_FILTER_KEYS).optional(),
  includeOlder: z.enum(['true', 'false']).default('false'),
});

const statusCountsSchema = z.object(
  Object.fromEntries(SIGNUP_DOMAIN_HOLD_STATUS_FILTERS.map(status => [status, z.number()])) as Record<
    (typeof SIGNUP_DOMAIN_HOLD_STATUS_FILTERS)[number],
    z.ZodNumber
  >
);

const sourceStatusSchema = z.object({
  source: z.string(),
  count: z.number(),
  lastSuccessAt: z.date().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.date().optional(),
});

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ, POST: 'users:moderate' },
})
  .get(
    asyncHandler(async (req, res) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('Invalid page, status, reason or includeOlder');
      const { page, status, reason, includeOlder } = parsed.data;
      const settings = await getSettingsMap(
        { adminSettings: adminSettingsRepository },
        { names: ['signupDomainHoldsSettledVisibleDays'] }
      );
      const settledVisibleDays = getSettingsValue('signupDomainHoldsSettledVisibleDays', settings, 90);
      const settledSince = includeOlder === 'true' ? undefined : new Date(Date.now() - settledVisibleDays * DAY_MS);
      const [data, counts, sources, intelCacheSize] = await Promise.all([
        signupDomainHoldListRepository.list({ status, reason, settledSince }, page, PAGE_SIZE),
        signupDomainHoldListRepository.countByStatus({ reason, settledSince }),
        disposableDomainRepository.getDisposableSourceStatus(),
        DomainIntelligenceModel.estimatedDocumentCount(),
      ]);
      respond(
        res,
        z.object({
          data: z.array(signupDomainReviewSchema),
          total: z.number(),
          counts: statusCountsSchema,
          settledVisibleDays: z.number(),
          sources: z.array(sourceStatusSchema),
          intelCacheSize: z.number(),
        }),
        { data, total: counts[status], counts, settledVisibleDays, sources, intelCacheSize }
      );
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a domain and confirm/release action');
      const { domain, action, afterUserId } = parsed.data;
      // Releasing pays out the pending free credits of every account on the domain.
      if (action === 'release') requireAdminPermission(req, 'credits:adjust');
      const status = action === 'release' ? 'released' : 'blocked';
      // A strict audit entry rides in the same transaction, so an unrecorded decision rolls back.
      const review = await withTransaction(async () => {
        // Release continuation pages and grant retries re-post an already released hold; that is not a new
        // decision, so it must not rewrite who (or which policy) released it.
        if (action === 'release') {
          const released = await SignupDomainReviewModel.findOne({ domain, status: 'released' });
          if (released) return released;
        }
        const previous = await SignupDomainReviewModel.findOneAndUpdate(
          { domain, status: { $in: ['held_pending_review', 'blocked'] } },
          // An admin decision supersedes an automated one (signupDomainHoldTriage), so its marker goes.
          { $set: { status, reviewedBy: req.user.id, reviewedAt: new Date() }, $unset: { autoDecision: 1 } },
          { new: false }
        );
        if (!previous) return null;
        await recordAdminActionFromRequest(req, {
          action: action === 'release' ? 'signup_domain_hold.released' : 'signup_domain_hold.confirmed',
          target: { kind: 'system', id: `signup-domain-hold:${domain}`, displayName: domain },
          summary: `${action === 'release' ? 'released' : 'confirmed'} the signup domain hold on ${domain}`,
          changes: [{ field: 'status', before: previous.status, after: status }],
          details: {
            reason: previous.reason,
            ...(previous.autoDecision ? { overrodeAutoDecision: previous.autoDecision.policy } : {}),
          },
        });
        return previous;
      });
      if (!review) throw new BadRequestError('Hold not found or already resolved with another decision');
      const fullAdmin = isFullAdmin(req.user);
      const { creditsReleased, remaining, nextCursor } =
        action === 'release'
          ? await releaseHeldSignupCredits(domain, {
              afterUserId,
              reason: 'Signup domain hold released by admin',
              bypassBudget: true,
              logger: req.logger,
              // A delegate never pays out to itself or to an account with admin access; those stay pending.
              skipUser: fullAdmin
                ? undefined
                : user => isSelfOrImpersonator(req.user, String(user._id)) || canAccessAdmin(user),
            })
          : { creditsReleased: 0, remaining: 0, nextCursor: null };
      res.status(200).json({ status, creditsReleased, remaining, nextCursor });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
