import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  lakeMembershipChangeEventRepository,
  userRepository,
} from '@bike4mind/database';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/** An ISO-8601 instant, or undefined when absent. Throws on a value that is present but unusable,
 * rather than silently diffing a window the caller did not ask for. */
const parseInstant = (raw: string | undefined, field: string): Date | undefined => {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`\`${field}\` must be an ISO-8601 date-time.`);
  return parsed;
};

/**
 * GET /api/data-lakes/:id/membership-diff?from=<iso>[&to=<iso>][&limit=]
 *
 * What joined and left this lake between two instants, and who drove each move. The read side of
 * the membership change log, and its first consumer.
 *
 * Two gates, in the same order and for the same reasons as the config-history route next to it:
 * `assertLakeAccess` for existence + read access (denying not-found-style), then
 * `resolveCanManageLake`, since a lake's contents over time sit at the altitude of the contents
 * themselves.
 *
 * Internal only - no API-key contract. A public endpoint here would have to commit to the
 * `unchangedCount` absence rule as a wire guarantee, and that is worth settling against a real
 * consumer first.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(
    async (
      req: Request<{ id: string }, unknown, unknown, { id: string; from?: string; to?: string; limit?: string }>,
      res
    ) => {
      // Next merges the [id] route param into req.query alongside the query string.
      const { id, from, to, limit } = req.query;
      const ctx = await toAccessContext(req);

      const lake = await dataLakeService.assertLakeAccess(id, ctx, {
        db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
      });

      const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
        db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
      });
      if (!canManage) {
        throw new ForbiddenError('You must be able to manage this data lake to view its membership changes.');
      }

      const fromAt = parseInstant(from, 'from');
      if (!fromAt) throw new BadRequestError('`from` is required and must be an ISO-8601 date-time.');

      const view = await dataLakeService.diffLakeMembership(lake, {
        db: {
          lakeMembershipChangeEvents: lakeMembershipChangeEventRepository,
          fabFiles: fabFileRepository,
          users: userRepository,
        },
        from: fromAt,
        to: parseInstant(to, 'to'),
        // Parsed permissively: the service clamps into [1, MAX], so a garbage ?limit= serves a page
        // instead of a 400. `limit ?` not `limit == null ?` - a bare `?limit=` is '' and Number('')
        // is 0, which the clamp floors to 1.
        limit: limit ? Number(limit) : undefined,
      });

      return res.json({ data: view });
    }
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;
