import { z } from 'zod';
import { Request } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { imageModerationIncidentRepository } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';

/**
 * Admin-only work-queue endpoint for image-moderation incidents that need attention.
 *
 * Returns two sets:
 *   - incidents with reviewStatus absent or 'pending_review' (unreviewed), oldest first.
 *   - incidents stuck in 'confirmed_csam' for more than 10 minutes (NCMEC submission had
 *     an unknown outcome -- the admin should verify with NCMEC before retrying).
 *
 * Drain the queue by calling GET `?limit=N`, processing the returned incidents, then
 * repeating until both arrays come back shorter than limit.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req: Request, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.issues });
  }

  const { limit } = parsed.data;
  const [incidents, staleConfirmedCsam] = await Promise.all([
    imageModerationIncidentRepository.findPendingReview(limit),
    imageModerationIncidentRepository.findStaleConfirmedCsam(limit),
  ]);
  return res.status(200).json({ incidents, staleConfirmedCsam });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
