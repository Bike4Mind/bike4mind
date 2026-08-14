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
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{ id: string }, unknown, unknown, { id: string; format?: string }>, res) => {
    // Next merges the [id] route param into req.query alongside the ?format= query string.
    const { id, format } = req.query;
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const canManage = await dataLakeService.resolveCanManageLake(lake, ctx, {
      db: { dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    if (!canManage) {
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

    return res.json({ data: view });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
