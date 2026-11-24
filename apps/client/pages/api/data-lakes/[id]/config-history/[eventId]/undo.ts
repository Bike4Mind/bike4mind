import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';
import { Request } from 'express';
import { toAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { undoLakeConfigChangeHandler } from '@server/dataLakes/research/undoHandler';

/**
 * POST /api/data-lakes/:id/config-history/:eventId/undo
 *
 * Reverses one History row through the ordinary service for the inverse change, so that service's
 * manage check and validation apply. Refuses with 409 when a later change touched the same item, or
 * when the old value no longer passes today's checks (the refusal names the field).
 */
const HOUR_MS = 60 * 60 * 1000;
const UNDO_HOURLY_CAP = 120;

const undoRateLimit = rateLimit({
  limit: () => (isDevelopment() ? Infinity : UNDO_HOURLY_CAP),
  windowMs: HOUR_MS,
  // The raw pathname embeds the lake and event ids, which would make every undo its own bucket.
  bucket: 'data-lakes/config-history-undo',
});

// Session-only: API keys reach undo through the /api/v1 twin.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .use(undoRateLimit)
  .post(async (req: Request<{}, unknown, unknown, { id: string; eventId: string }>, res) => {
    const { id, eventId } = req.query;
    const ctx = await toAccessContext(req);

    const result = await undoLakeConfigChangeHandler(req, id, eventId, ctx);

    return res.json({ data: result });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
