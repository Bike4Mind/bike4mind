import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, userRepository } from '@bike4mind/database';
import { CreateDataLakeRequestInput } from '@bike4mind/common';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { resolveActiveOrg } from '@server/dataLakes/resolveActiveOrg';

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  // GET /api/data-lakes - list accessible data lakes
  .get(async (req: Request, res) => {
    const ctx = await toAccessContext(req);
    // The `users` adapter labels lakes the caller does not own with the creator's name: the
    // manager list is "lakes I can reach", not "lakes I own" (org lakes, others' public lakes,
    // and - for an admin - every tenant's lakes surface here), so a not-own lake is marked to
    // prevent an admin from managing someone else's by mistake.
    const db = { dataLakes: dataLakeRepository, users: userRepository };
    // Admins see all data lakes; non-admins see only those they can access (owner/org/tag).
    const dataLakes = ctx.isAdmin
      ? await dataLakeService.listAllDataLakes(ctx, { db })
      : await dataLakeService.listDataLakes(ctx, { db });

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
