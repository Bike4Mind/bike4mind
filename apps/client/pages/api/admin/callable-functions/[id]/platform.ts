import type { Request } from 'express';
import { z } from 'zod';
import { ApiKeyScope, ConflictError, NotFoundError, shownCallableFunctionTrustLabel } from '@bike4mind/common';
import { callableFunctionRepository, mongoose, withTransaction } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';

/**
 * The `platform` trust label on any person's callable function.
 *   POST   -> mark it, only while it is live and `verified`; records the admin on the function and in the audit log.
 *   DELETE -> remove the mark.
 * A code, data, or source edit that returns the function to draft, and a promotion or examples edit that leaves it
 * `unverified`, drop the mark too (CallableFunctionModel).
 */

const ReasonSchema = z.object({ reason: z.string().max(1000).optional() });

const NOT_FOUND = 'Function not found';

const view = (fn: Parameters<typeof shownCallableFunctionTrustLabel>[0] & { id: string }) => ({
  id: fn.id,
  trustLabel: shownCallableFunctionTrustLabel(fn),
  platform: fn.platform ? { setBy: fn.platform.setBy, setAt: fn.platform.setAt } : null,
});

const handler = adminApi({
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'models:curate', DELETE: 'models:curate' },
})
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
    req.logger.info(`[CALLABLE_FUNCTION] platform label removed from ${id} by admin=${req.user.id}`);
    return res.status(200).json(view(cleared));
  });

export default handler;
