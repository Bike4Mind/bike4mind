import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { DATA_LAKE_ACCESS_ROLES, DATA_LAKE_PRINCIPAL_TYPES } from '@bike4mind/common';
import { dataLakeRepository, dataLakeAccessGrantRepository, userRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { firstQueryValue } from '@server/dataLakes/firstQueryValue';

const GrantInput = z.object({
  principalType: z.enum(DATA_LAKE_PRINCIPAL_TYPES),
  /** An `organization` principal only; a `user` is named by email. Trimmed because this string is
   *  half of a grant's natural key, so a padded variant would address a second row. */
  principalId: z.string().trim().min(1).optional(),
  /** A `user` principal named by email - the only usable input for the cross-tenant sharing case,
   *  and the only one the service can resolve to a real account before writing. */
  principalEmail: z.string().email().optional(),
  // `owner` is accepted by the schema and refused by the service, deliberately: its refusal names
  // transfer-ownership as the way through, which a bare enum-validation error could not.
  role: z.enum(DATA_LAKE_ACCESS_ROLES),
  expiresAt: z.coerce.date().nullish(),
});

const RevokeInput = z.object({
  principalType: z.enum(DATA_LAKE_PRINCIPAL_TYPES),
  principalId: z.string().trim().min(1),
});

/** Next merges the [id] route param into req.query alongside any real query string. */
interface GrantsQuery {
  id: string;
  principalType?: string | string[];
  principalId?: string | string[];
}

/**
 * POST   /api/data-lakes/:id/grants  { principalType, principalId | principalEmail, role, expiresAt? }
 * DELETE /api/data-lakes/:id/grants?principalType=&principalId=
 *
 * The routine access-sharing door for one lake: the sole producer of `reader` and organization
 * grants. A sibling resource to `transfer-ownership` rather than more verbs on `/access`, which is
 * a read-only compliance artifact with a CSV representation.
 *
 * Access-gated first with `assertLakeAccess`, so a caller who cannot even see the lake gets the
 * not-found-style denial and learns nothing; the service then applies the manage gate and the
 * grant-write rules (no `owner` role here, an organization principal must be the lake's own, and it
 * can only be a reader).
 *
 * DELETE takes the principal in the query rather than a body: the pair is an identifier, and a
 * request body on DELETE is unevenly supported by intermediaries.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, GrantsQuery>, res) => {
    const { id } = req.query;
    const input = GrantInput.parse(req.body);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };
    const data = await dataLakeService.grantLakeAccess(actor, lake.id, input, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        users: userRepository,
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json({ data });
  })
  .delete(async (req: Request<{}, unknown, unknown, GrantsQuery>, res) => {
    const { id } = req.query;
    const input = RevokeInput.parse({
      principalType: firstQueryValue(req.query.principalType),
      principalId: firstQueryValue(req.query.principalId),
    });
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo) };
    const data = await dataLakeService.revokeLakeAccess(actor, lake.id, input, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        users: userRepository,
        ...lakeConfigAuditDb,
      },
      logger: req.logger,
    });

    return res.json({ data });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
