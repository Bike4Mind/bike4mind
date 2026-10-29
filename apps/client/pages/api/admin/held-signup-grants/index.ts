import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { signupGrantReleaseRepository } from '@bike4mind/database';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';

const querySchema = z.object({
  reason: z.enum(['budget_exhausted', 'risk_review']).optional(),
  after: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
});
const PAGE_SIZE = 25;

const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError('Invalid reason or cursor');
    const rows = await signupGrantReleaseRepository.listHeld({
      reason: parsed.data.reason,
      afterId: parsed.data.after,
      limit: PAGE_SIZE + 1,
    });
    const data = rows.slice(0, PAGE_SIZE);
    res.status(200).json({ data, nextCursor: rows.length > PAGE_SIZE ? data[data.length - 1].id : null });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
