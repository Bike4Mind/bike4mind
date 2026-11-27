import type { Request } from 'express';
import { z } from 'zod';
import {
  ApiKeyScope,
  CALLABLE_FUNCTION_PLATFORM_AUDIENCES,
  ConflictError,
  NotFoundError,
  shownCallableFunctionTrustLabel,
} from '@bike4mind/common';
import { callableFunctionRepository, mongoose, withTransaction } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';
import { dropUncoveredCallableFunctionReviews } from '@bike4mind/server-utils/callableFunctions/sharing';

/**
 * The `platform` trust label on any person's callable function.
 *   POST   -> mark it, only while it is live and `verified`; records the admin on the function and in the audit log.
 *   PATCH  -> `{ audience: "signed_in" }` offers a marked function to every signed-in person, each of whom still
 *             reviews it before a first call; `{ audience: null }` withdraws the offer.
 *   DELETE -> remove the mark, and with it the audience.
 * A code, data, or source edit that returns the function to draft, and a promotion or examples edit that leaves it
 * `unverified`, drop the mark and the audience too (CallableFunctionModel). Removing either deletes the reviews of
 * the people it no longer reaches.
 */

const ReasonSchema = z.object({ reason: z.string().max(1000).optional() });

const AudienceSchema = z.object({
  audience: z.enum(CALLABLE_FUNCTION_PLATFORM_AUDIENCES).nullable(),
  reason: z.string().max(1000).optional(),
});

const NOT_FOUND = 'Function not found';

const view = (fn: Parameters<typeof shownCallableFunctionTrustLabel>[0] & { id: string }) => ({
  id: fn.id,
  trustLabel: shownCallableFunctionTrustLabel(fn),
  platform: fn.platform ? { setBy: fn.platform.setBy, setAt: fn.platform.setAt } : null,
  audience: fn.platform?.audience ?? null,
});

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000, bucket: 'admin-callable-function-platform' } as const;

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'models:curate', PATCH: 'models:curate', DELETE: 'models:curate' },
})
  .use(rateLimit(RATE_LIMIT))
  .post(async (req: Request, res) => {
    const id = String(req.query.id);
    const parsed = ReasonSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const current = mongoose.isObjectIdOrHexString(id) ? await callableFunctionRepository.findById(id) : null;
    if (!current) throw new NotFoundError(NOT_FOUND);

    const marked = await withTransaction(async () => {
      const fn = await callableFunctionRepository.setPlatformMark(id, {
        setBy: String(req.user.id),
        setAt: new Date(),
      });
      if (!fn) return null;
      await recordAdminActionFromRequest(req, {
        action: 'callable_function.platform.marked',
        target: await userAuditTarget(fn.userId),
        summary: `marked callable function ${fn.slug} as platform`,
        details: { functionId: fn.id, slug: fn.slug },
        reason: parsed.data.reason,
      });
      return fn;
    });
    if (!marked) {
      throw new ConflictError('Only a live, verified function can carry the platform label.', {
        code: 'not_verified',
      });
    }
    req.logger.info(`[CALLABLE_FUNCTION] platform label set on ${id} by admin=${req.user.id}`);
    return res.status(200).json(view(marked));
  })
  .patch(async (req: Request, res) => {
    const id = String(req.query.id);
    const parsed = AudienceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const { audience, reason } = parsed.data;
    const current = mongoose.isObjectIdOrHexString(id) ? await callableFunctionRepository.findById(id) : null;
    if (!current) throw new NotFoundError(NOT_FOUND);

    const saved = await withTransaction(async () => {
      const fn = await callableFunctionRepository.setPlatformAudience(id, audience);
      if (!fn) return null;
      await recordAdminActionFromRequest(req, {
        action: audience ? 'callable_function.audience.set' : 'callable_function.audience.cleared',
        target: await userAuditTarget(fn.userId),
        summary: audience
          ? `offered callable function ${fn.slug} to everyone signed in`
          : `withdrew callable function ${fn.slug} from everyone signed in`,
        details: { functionId: fn.id, slug: fn.slug, ...(audience ? { audience } : {}) },
        reason,
      });
      return fn;
    });
    if (!saved && audience) {
      throw new ConflictError('Only a live, verified function with the platform label can be offered to everyone.', {
        code: 'not_platform',
      });
    }
    if (!saved) throw new NotFoundError('No audience on that function');
    if (!audience) await dropUncoveredCallableFunctionReviews(saved);
    req.logger.info(`[CALLABLE_FUNCTION] audience ${audience ?? 'removed'} on ${id} by admin=${req.user.id}`);
    return res.status(200).json(view(saved));
  })
  .delete(async (req: Request, res) => {
    const id = String(req.query.id);
    const cleared = await withTransaction(async () => {
      const fn = await callableFunctionRepository.clearPlatformMark(id);
      if (!fn) return null;
      await recordAdminActionFromRequest(req, {
        action: 'callable_function.platform.cleared',
        target: await userAuditTarget(fn.userId),
        summary: `removed the platform label from callable function ${fn.slug}`,
        details: { functionId: fn.id, slug: fn.slug },
      });
      return fn;
    });
    if (!cleared) throw new NotFoundError('No platform label on that function');
    await dropUncoveredCallableFunctionReviews(cleared);
    req.logger.info(`[CALLABLE_FUNCTION] platform label removed from ${id} by admin=${req.user.id}`);
    return res.status(200).json(view(cleared));
  });

export default handler;
