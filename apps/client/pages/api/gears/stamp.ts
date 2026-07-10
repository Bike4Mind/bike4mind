import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { z } from 'zod';
import { gearStampRepository } from '@bike4mind/database';

/**
 * POST /api/gears/stamp — client-claimable first-use stamps.
 *
 * SECURITY: the allowlist below is the whole design. A client-callable stamp
 * is self-attested ("I looked at the docs"), so ONLY low-value, curiosity-tier
 * gears may ever appear here — anything whose reward is worth farming must be
 * derived server-side or stamped by the action's own route instead.
 */
const CLIENT_STAMPABLE = ['clidocs'] as const;

const BodySchema = z.object({
  key: z.enum(CLIENT_STAMPABLE),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
    await gearStampRepository.stamp(String(userId), parsed.data.key);
    return res.status(204).end();
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
