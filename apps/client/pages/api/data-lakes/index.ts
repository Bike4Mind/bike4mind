import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository } from '@bike4mind/database';
import { CreateDataLakeRequestInput } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { resolveActiveOrg } from '@server/dataLakes/resolveActiveOrg';

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET /api/data-lakes - list accessible data lakes
  .get(async (req: Request, res) => {
    // Admins see all data lakes; non-admins see only those they can access (owner/org/tag).
    const dataLakes = req.user.isAdmin
      ? await dataLakeService.listAllDataLakes({ db: { dataLakes: dataLakeRepository } })
      : await dataLakeService.listDataLakes(await toAccessContext(req), { db: { dataLakes: dataLakeRepository } });

    return res.json({ data: dataLakes });
  })
  // POST /api/data-lakes - create a new data lake
  .post(async (req: Request, res) => {
    const userId = req.user.id;
    const params = CreateDataLakeRequestInput.parse(req.body);

    // Scope to the caller's active account-switcher org (sent in the body), authorization-
    // validated against their memberships first - never trusted as-is. Undefined -> personal.
    const organizationId = await resolveActiveOrg(req, params.organizationId);

    const dataLake = await dataLakeService.createDataLake(
      userId,
      params,
      { db: { dataLakes: dataLakeRepository } },
      organizationId
    );

    return res.status(201).json(dataLake);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
