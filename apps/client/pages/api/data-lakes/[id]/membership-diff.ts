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

/**
 * A full ISO-8601 instant with an explicit offset. Deliberately stricter than `new Date`, which
 * accepts `2026` or `June 1 2026` and reads an offset-less value in the SERVER's timezone - so the
 * same request would name a different window depending on where it landed.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Throws on a value that is present but unusable, rather than silently diffing a window the caller
 * did not ask for. */
const parseInstant = (raw: string | undefined, field: string): Date | undefined => {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (!ISO_INSTANT.test(raw) || Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`\`${field}\` must be an ISO-8601 date-time with an explicit UTC offset.`);
  }
  // V8 rolls an out-of-range day over rather than refusing it, so `2026-02-30` parses as March 2nd.
  // Checked against the literal date fields, not a `toISOString()` round trip, which an offset
  // legitimately shifts across midnight.
  const [year, month, day] = raw.slice(0, 10).split('-').map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  if (asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month - 1 || asUtc.getUTCDate() !== day) {
    throw new BadRequestError(`\`${field}\` names a date that does not exist.`);
  }
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

      // A fallback (static registry) lake gates on `ctx.isAdmin` DIRECTLY, the way every other
      // registry gate here does: its synthetic document spreads `organizationId` from the registry
      // config, so `canManageLake`'s org-admin rung would otherwise hand a customer-side org admin
      // a platform lake's history.
      const canManage = dataLakeService.isFallbackLake(lake)
        ? ctx.isAdmin
        : await dataLakeService.resolveCanManageLake(lake, ctx, {
            db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
          });
      if (!canManage) {
        throw new ForbiddenError('You must be able to manage this data lake to view its membership changes.');
      }

      const fromAt = parseInstant(from, 'from');
      if (!fromAt) throw new BadRequestError('`from` is required and must be an ISO-8601 date-time.');
      // The window end clamps to now, so a future `from` ends the window before it starts whether or
      // not `to` was supplied - and every read over it comes back empty, which reads as stillness.
      if (fromAt.getTime() > Date.now()) {
        throw new BadRequestError('`from` must not be in the future.');
      }
      const toAt = parseInstant(to, 'to');
      // A backwards window would otherwise read as 200 with empty lists and an `unchangedCount`
      // rewound over a span that was never asked about.
      if (toAt && toAt.getTime() < fromAt.getTime()) {
        throw new BadRequestError('`to` must not be earlier than `from`.');
      }

      const view = await dataLakeService.diffLakeMembership(lake, {
        db: {
          lakeMembershipChangeEvents: lakeMembershipChangeEventRepository,
          fabFiles: fabFileRepository,
          users: userRepository,
        },
        from: fromAt,
        to: toAt,
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
