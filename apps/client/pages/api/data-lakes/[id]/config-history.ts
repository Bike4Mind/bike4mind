import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { Request } from 'express';
import { toAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { readLakeConfigHistory } from '@server/dataLakes/research/configHistoryHandler';

/**
 * GET /api/data-lakes/:id/config-history[?limit=][&include=files]
 *
 * The owner-facing config-change history (#1769): who changed how this lake answers, what each
 * change moved from and to, and which manage rung authorized it. Read-only, and the FIRST consumer
 * of the config-change collection - it was written dormant so the audit trail would already have
 * depth by the time this shipped.
 *
 * Two gates, in order (in `readLakeConfigHistory`, shared with the public v1 route). FORWARD
 * REFERENCE: the owner-facing access view (#1672) is expected to land with this same pair, so the
 * two halves of the audit trail cannot diverge on who may read them - that route does not exist
 * yet, so this is the shape to match, not a shape copied from one:
 *  1. `assertLakeAccess` - existence + read access, denying with a not-found-style error so a lake
 *     the caller cannot even see is not disclosed.
 *  2. `resolveCanManageLake` - MANAGE, not access. The history describes editor-only fields
 *     (`systemPrompt`, the gate config), so it sits at exactly the altitude of the fields it
 *     describes; a caller who can merely READ the lake is refused with a 403, since gate 1 already
 *     told them it exists and hiding it as not-found would buy nothing.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(
    async (req: Request<{ id: string }, unknown, unknown, { id: string; limit?: string; include?: string }>, res) => {
      // Next merges the [id] route param into req.query alongside the ?limit= query string.
      const { id, limit, include } = req.query;
      const ctx = await toAccessContext(req);

      // Parsed permissively rather than validated: the service clamps into [1, MAX] and falls back to
      // the default for anything non-finite, so a garbage ?limit= serves a page instead of a 400.
      // `limit ?` not `limit == null ?`: a bare `?limit=` arrives as '' and `Number('')` is 0, which
      // the clamp floors to 1 - silently serving a one-row history instead of the default page.
      const view = await readLakeConfigHistory(id, ctx, limit ? Number(limit) : undefined, include === 'files');

      return res.json({ data: view });
    }
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;
