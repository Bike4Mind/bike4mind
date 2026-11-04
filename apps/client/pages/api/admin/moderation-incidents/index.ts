import { z } from 'zod';
import { Request } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { imageModerationIncidentRepository, userRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

/**
 * Admin-only work-queue endpoint for image-moderation incidents.
 *
 * `status=open` (default) returns two sets:
 *   - incidents with reviewStatus absent or 'pending_review' (unreviewed), oldest first.
 *   - incidents stuck in 'confirmed_csam' for more than 10 minutes (NCMEC submission had
 *     an unknown outcome -- the admin should verify with NCMEC before retrying).
 * `status=closed` returns incidents with a final verdict, newest first, in `incidents`
 * (`staleConfirmedCsam` is empty), so past verdicts can be looked up.
 *
 * Each incident carries `userEmail` (null when the account is gone) so the queue can name who
 * was flagged.
 *
 * Drain the queue by calling GET `?limit=N`, processing the returned incidents, then
 * repeating until both arrays come back shorter than limit.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['open', 'closed']).default('open'),
});

type QueueIncident = { userId: string };

const withUserEmails = async <T extends QueueIncident>(lists: T[][]) => {
  const userIds = [...new Set(lists.flat().map(incident => incident.userId))];
  const users = await userRepository.findByIds(userIds);
  const emailById = new Map(users.map(user => [String(user.id), user.email ?? null]));
  return lists.map(list => list.map(incident => ({ ...incident, userEmail: emailById.get(incident.userId) ?? null })));
};

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req: Request, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.issues });
  }

  const { limit, status } = parsed.data;
  if (status === 'closed') {
    const [incidents] = await withUserEmails([await imageModerationIncidentRepository.findClosed(limit)]);
    return res.status(200).json({ incidents, staleConfirmedCsam: [] });
  }

  const [pending, stale] = await Promise.all([
    imageModerationIncidentRepository.findPendingReview(limit),
    imageModerationIncidentRepository.findStaleConfirmedCsam(limit),
  ]);
  const [incidents, staleConfirmedCsam] = await withUserEmails([pending, stale]);
  return res.status(200).json({ incidents, staleConfirmedCsam });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
