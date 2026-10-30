import { z } from 'zod';
import { ApiKeyScope, type IntegrationRequestersResponse } from '@bike4mind/common';
import { integrationRequestRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';

/**
 * GET /api/admin/integrations/demand/{integrationId}/requesters?limit&cursor - who requested one
 * integration, newest first, cursor-paginated (`next_cursor` is null on the last page).
 *
 * Any id with rows is accepted, not only planned ones, so the history of a promoted entry stays
 * readable. Names, emails and organization names are resolved in two batched reads per page and
 * reduced to those fields here; nothing else from either document reaches the response.
 *
 * A requester whose account is gone or soft-deleted comes back `deleted: true` with no name or
 * email, and the organization shown is the one the user belongs to now (the request's stored one
 * only when the user has none), since requests keep the organization they were filed under.
 */

const QuerySchema = z.object({
  integrationId: z.string().min(1).max(64),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const ONE_MINUTE_MS = 60 * 1000;
// Higher than the summary route: "Copy emails" walks every page of one integration in a burst.
export const INTEGRATION_REQUESTERS_RATE_LIMIT = 60;

// Same gate as the summary route: admin:* for API keys, adminApi permission for everyone.
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(
    rateLimit({
      limit: INTEGRATION_REQUESTERS_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-integration-demand-requesters',
    })
  )
  .get(async (req, res) => {
    const query = QuerySchema.safeParse(req.query);
    if (!query.success) {
      throw new UnprocessableEntityError(
        query.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      );
    }
    const { integrationId, cursor, limit } = query.data;
    // Scoped per integration, so a cursor minted for one list is refused by another.
    const cursorScope = `admin.integration-demand.requesters.${integrationId}`;
    const after = cursor === undefined ? undefined : decodeTimeIdCursor(cursor, cursorScope);

    const { items, hasMore } = await integrationRequestRepository.requestersFor(integrationId, {
      limit,
      after: after && { createdAt: after.at, id: after.id },
    });

    const users = await userRepository.findRequesterProfilesByIds([...new Set(items.map(item => item.userId))]);
    const userById = new Map(users.map(user => [user.id, user]));
    const organizationIdOf = (item: (typeof items)[number]) =>
      userById.get(item.userId)?.organizationId ?? item.organizationId;

    const orgIds = [...new Set(items.map(organizationIdOf).filter(isValidObjectId))];
    const organizations =
      orgIds.length > 0 ? await organizationRepository.find({ _id: { $in: orgIds } }, { name: 1 }) : [];
    const orgNameById = new Map(organizations.map(org => [String(org._id), org.name]));

    const last = items[items.length - 1];
    const body: IntegrationRequestersResponse = {
      data: items.map(item => {
        const user = userById.get(item.userId);
        const deleted = !user || user.deleted;
        const organizationId = organizationIdOf(item);
        return {
          userId: item.userId,
          deleted,
          name: deleted ? null : (user.name ?? null),
          email: deleted ? null : (user.email ?? null),
          organizationId,
          organizationName: (organizationId && orgNameById.get(organizationId)) || null,
          requestedAt: item.createdAt.toISOString(),
        };
      }),
      next_cursor: hasMore ? encodeTimeIdCursor(cursorScope, { at: last.createdAt, id: last.id }) : null,
    };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(body);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
