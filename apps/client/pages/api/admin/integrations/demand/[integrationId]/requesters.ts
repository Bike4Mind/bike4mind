import { z } from 'zod';
import { ApiKeyScope, type IntegrationRequestersResponse } from '@bike4mind/common';
import { integrationRequestRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { decodeTimeIdCursor, encodeTimeIdCursor } from '@server/utils/cursorPagination';
import { ForbiddenError, UnprocessableEntityError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';

/**
 * GET /api/admin/integrations/demand/{integrationId}/requesters?limit&cursor - who requested one
 * integration, newest first, cursor-paginated (`next_cursor` is null on the last page).
 *
 * Any id with rows is accepted, not only planned ones, so the history of a promoted entry stays
 * readable. Names, emails and organization names are resolved in two batched reads per page and
 * reduced to those fields here; nothing else from either document reaches the response.
 */

const QuerySchema = z.object({
  integrationId: z.string().min(1).max(64),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const ONE_MINUTE_MS = 60 * 1000;
// Higher than the summary route: "Copy emails" walks every page of one integration in a burst.
export const INTEGRATION_REQUESTERS_RATE_LIMIT = 60;

// Same gate as the summary route: admin:* for API keys, isAdmin for everyone.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .use(
    rateLimit({
      limit: INTEGRATION_REQUESTERS_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-integration-demand-requesters',
    })
  )
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

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

    const orgIds = [...new Set(items.map(item => item.organizationId).filter(isValidObjectId))];
    const [users, organizations] = await Promise.all([
      userRepository.findByIds([...new Set(items.map(item => item.userId))]),
      orgIds.length > 0 ? organizationRepository.find({ _id: { $in: orgIds } }, { name: 1 }) : Promise.resolve([]),
    ]);
    const userById = new Map(users.map(user => [String(user.id), { name: user.name, email: user.email }]));
    const orgNameById = new Map(organizations.map(org => [String(org._id), org.name]));

    const last = items[items.length - 1];
    const body: IntegrationRequestersResponse = {
      data: items.map(item => {
        const user = userById.get(item.userId);
        return {
          userId: item.userId,
          name: user?.name ?? null,
          email: user?.email ?? null,
          organizationId: item.organizationId,
          organizationName: (item.organizationId && orgNameById.get(item.organizationId)) || null,
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
