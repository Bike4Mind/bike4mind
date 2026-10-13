import { z } from 'zod';
import { Request } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { imageModerationIncidentRepository } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';

/**
 * Admin-only paginated list of unreviewed image-moderation incidents.
 *
 * Returns incidents with reviewStatus absent or 'pending_review', oldest first.
 * Operator loop: GET `?limit=N` until the response array is shorter than limit.
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

  const incidents = await imageModerationIncidentRepository.findPendingReview(parsed.data.limit);
  return res.status(200).json({ incidents });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
