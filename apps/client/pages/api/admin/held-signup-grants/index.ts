import { z } from 'zod';
import { signupGrantReleaseRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { findRiskReviewAdvisories } from '@server/security/abuseAssessment/riskReviewAdvisory';

const querySchema = z.object({
  reason: z.enum(['budget_exhausted']).optional(),
  after: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
});
const PAGE_SIZE = 25;

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'credits:adjust' } }).get(
  asyncHandler(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError('Invalid reason or cursor');
    const rows = await signupGrantReleaseRepository.listHeld({
      reason: parsed.data.reason,
      afterId: parsed.data.after,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    // Display-only hint, same source as the risk review queue; a failed read shows no advisories.
    const advisories = await findRiskReviewAdvisories(
      page.map(row => row.id),
      req.logger
    ).catch(error => {
      req.logger.warn('Held signup grant advisories unavailable', { error });
      return new Map();
    });
    const data = page.map(row => ({ ...row, advisory: advisories.get(row.id) ?? null }));
    res.status(200).json({ data, nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1].id : null });
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
