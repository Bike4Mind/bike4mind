import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  userRepository,
  organizationRepository,
} from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

const TransferOwnershipInput = z.object({
  newOwnerUserId: z.string().min(1),
});

/**
 * POST /api/data-lakes/:id/transfer-ownership  { newOwnerUserId }
 * Transfer a lake's ownership to another user. Ownership is carried by an owner-role access grant
 * (not `createdByUserId`, which stays the immutable creator), so this upserts an owner grant for the
 * new owner and demotes prior owners to curator. Access-gated first (not-found-style denial), then
 * the service enforces the narrower transfer authorization (platform admin, current effective owner,
 * or an admin of the lake's org - the orphaned-creator succession path) and validates the new owner.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const { newOwnerUserId } = TransferOwnershipInput.parse(req.body);
    const ctx = await toAccessContext(req);

    // Resolve + access-gate the lake first, so a caller who can't even see it gets a not-found
    // (no existence leak). The service then applies the stricter transfer authorization.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };
    const result = await dataLakeService.transferLakeOwnership(actor, lake.id, newOwnerUserId, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        users: userRepository,
        organizations: organizationRepository,
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json(result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
