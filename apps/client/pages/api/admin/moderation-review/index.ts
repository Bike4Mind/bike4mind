import { z } from 'zod';
import { Request } from 'express';
import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { userRepository } from '@bike4mind/database';

/**
 * Admin review list for text-prompt moderation flags: users awaiting a decision (`throttled`,
 * `suspend_pending`) and users with a severe-category hit no admin has acted on yet.
 *
 * Read-only. Decisions (confirm suspend, clear, keep throttled) go through PUT /api/users/[id]/update
 * with `moderationStatus`, which gates on `users:moderate` and writes the audit entry.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
}).get(async (req: Request, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.issues });
  }
  const users = await userRepository.findModerationReviewQueue(parsed.data.limit);
  return res.status(200).json({ users });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
