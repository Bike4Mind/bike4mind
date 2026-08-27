import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  lakeAccessEventRepository,
  userRepository,
  organizationRepository,
} from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeAccessViewToCsv, lakeAccessViewCsvFilename } from '@server/dataLakes/lakeAccessViewCsv';
import { firstQueryValue } from '@server/dataLakes/firstQueryValue';

/**
 * GET /api/data-lakes/:id/access[?format=csv]
 *
 * The owner-facing access & membership view (#1672): who can reach this lake (persisted grants +
 * the gate-based channels, with grant expiry resolved live) and who actually has (the access-audit
 * trail). Read-only.
 *
 * Two gates, in order:
 *  1. `assertLakeAccess` - existence + read access, denying with a not-found-style error so a lake
 *     the caller can't even see is not disclosed.
 *  2. `resolveCanManageLake` - the view exposes who-read-what, which is manager-only. A caller who
 *     can merely READ the lake is refused here with a 403 (the lake's existence is already known to
 *     them from gate 1, so hiding it as not-found would be pointless).
 *
 * `?format=csv` streams the same view as a sectioned CSV compliance artifact; default is JSON.
 *
 * The JSON response carries `meta.canTransferOwnership` - whether THIS caller may hand the lake on,
 * which is narrower than managing it (see `resolveLakeTransferAuthority`). It rides in `meta`, not in
 * the view, because the view is the exported compliance artifact: a per-viewer capability is not a
 * fact about the lake's access and must not appear in the CSV.
 */
/** `format` is `string[]` for a repeated query param - see firstQueryValue. */
interface AccessQuery {
  id: string;
  format?: string | string[];
}

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{ id: string }, unknown, unknown, AccessQuery>, res) => {
    // Next merges the [id] route param into req.query alongside the ?format= query string, so `id` is
    // always a string. `format` is a genuine query param and arrives as an array for
    // `?format=csv&format=csv`, where `(format ?? '').toLowerCase()` threw a TypeError - a 500 raised
    // AFTER the manage gate and the whole access aggregation had already run.
    const { id } = req.query;
    const format = firstQueryValue(req.query.format);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    // Grants read ONCE and applied to both decisions: the manage gate below and the transfer
    // capability further down. `resolveCanManageLake` would re-query them for the same answer.
    const grants = await dataLakeService.loadActiveLakeGrants(lake, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    if (!dataLakeService.canManageLake(lake, ctx, grants)) {
      throw new ForbiddenError('You must be able to manage this data lake to view its access.');
    }

    const view = await dataLakeService.assembleLakeAccessView(lake, {
      db: {
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        lakeAccessEvents: lakeAccessEventRepository,
        users: userRepository,
        organizations: organizationRepository,
      },
    });

    if ((format ?? '').toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=${lakeAccessViewCsvFilename(view)}`);
      return res.send(lakeAccessViewToCsv(view));
    }

    return res.json({
      data: view,
      meta: { canTransferOwnership: dataLakeService.resolveLakeTransferAuthority(lake, ctx, grants).allowed },
    });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
