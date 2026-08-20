import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository } from '@bike4mind/database';
import { Request } from 'express';
import { z } from 'zod';
import { resolveActiveOrg } from '@server/utils/resolveActiveOrg';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

// The active account-switcher org (client-supplied) is the org a promotion targets. It is
// authorization-validated (resolveActiveOrg) before use, so it can't scope a lake into an
// org the caller doesn't belong to. Omitted -> personal (valid for private and public, which
// are both org-less). 'public' exposes the lake app-wide; the service refuses it for a gated lake.
const VisibilityInput = z.object({
  visibility: z.enum(['private', 'organization', 'public']),
  organizationId: z.string().optional(),
});

/**
 * POST /api/data-lakes/:id/visibility  { visibility: 'private' | 'organization' | 'public', organizationId? }
 * Set a lake's visibility: private (owner-only), organization (shared to the caller's active
 * org), or public (readable app-wide). The active org is client-supplied but authorization-
 * validated against the caller's memberships (resolveActiveOrg) before it becomes the org
 * target; it is ignored for private/public (both org-less). Access-gated first (not-found-style
 * denial), then the service enforces owner-only exposure and the no-gated-public guardrail.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
    const { id } = req.query;
    const { visibility, organizationId } = VisibilityInput.parse(req.body);
    // Validate the client-supplied active org against the caller's memberships before it can
    // become a promotion target. On demotion to private this is a no-op (org ignored).
    const activeOrg = await resolveActiveOrg(req, organizationId);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    const result = await dataLakeService.setLakeVisibility(
      // The promotion TARGET stays the per-request validated active org - a write input,
      // not an authorization read (#1674). administeredOrgIds rides the shared context
      // (toAccessContext resolves it once) for the org-manageable manage rung (#1668).
      {
        userId: ctx.userId,
        isAdmin: ctx.isAdmin,
        organizationId: activeOrg,
        administeredOrgIds: ctx.administeredOrgIds,
        auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo),
      },
      lake.id,
      visibility,
      {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          ...lakeConfigAuditDb,
        },
        logger: req.logger,
      }
    );

    return res.json(result);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
