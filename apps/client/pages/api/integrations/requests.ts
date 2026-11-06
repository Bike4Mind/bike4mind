import { z } from 'zod';
import { PLANNED_INTEGRATION_IDS, isPlannedIntegrationId } from '@bike4mind/common';
import { integrationRequestRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';

/**
 * /api/integrations/requests - demand capture for the roadmap cards on /integrations.
 *
 * GET    -> { counts: { [plannedId]: number }, mine: plannedId[] }
 * POST   { integrationId } -> records the caller's request; repeating it is a no-op
 * DELETE ?integrationId=   -> withdraws the caller's request
 *
 * Only `planned` ids from the integrations catalog in @bike4mind/common are accepted, so a
 * request can never be filed against a live integration or an arbitrary string. Session-only
 * (`jwtOnly`): this is a click in the gallery, not something an API key needs.
 */
const IntegrationIdSchema = z.object({
  integrationId: z.string().max(64).refine(isPlannedIntegrationId, { message: 'Unknown roadmap integration' }),
});

const ONE_MINUTE_MS = 60 * 1000;
// Generous for a page that reads once and toggles a few buttons; tight enough that one caller
// cannot churn the collection.
export const INTEGRATION_REQUESTS_RATE_LIMIT = 60;

const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: INTEGRATION_REQUESTS_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'integration-requests' }))
  .get(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Rows for an id later promoted out of the roadmap stay in the collection but are never counted here.
    const [counts, requested] = await Promise.all([
      integrationRequestRepository.countsByIntegration(PLANNED_INTEGRATION_IDS),
      integrationRequestRepository.requestedBy(String(userId)),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({ counts, mine: requested.filter(isPlannedIntegrationId) });
  })
  .post(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = IntegrationIdSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid integrationId' });

    const organizationId = req.user?.organizationId ? String(req.user.organizationId) : null;
    await integrationRequestRepository.request(String(userId), parsed.data.integrationId, organizationId);
    return res.status(204).end();
  })
  .delete(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const parsed = IntegrationIdSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid integrationId' });

    await integrationRequestRepository.withdraw(String(userId), parsed.data.integrationId);
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
