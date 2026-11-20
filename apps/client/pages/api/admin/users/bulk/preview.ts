import { ApiKeyScope, isFullAdmin } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi, requireAdminPermission } from '@server/middlewares/adminApi';
import { providerIdSearchAudit } from '@bike4mind/server-utils/admin/usersList/providerIdSearchAudit';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { selfIdsOf } from '@server/admin/usersBulk/actor';
import { usersBulkPreviewDeps, usersBulkResolveDeps } from '@bike4mind/server-utils/admin/usersBulk/adapters';
import { previewAdminUsersBulk, resolveAdminUsersBulk } from '@bike4mind/server-utils/admin/usersBulk/resolve';
import {
  ADMIN_USERS_BULK_ROUTE_PERMISSIONS,
  AdminUsersBulkPreviewRequestSchema,
  adminUsersBulkActionPermissions,
  type AdminUsersBulkPreview,
} from '@bike4mind/server-utils/app/utils/adminUsersBulk';

const ONE_MINUTE_MS = 60_000;
export const USERS_BULK_PREVIEW_RATE_LIMIT = 60;

/** Dry run of a users-list bulk action: what it would touch and change. Writes nothing. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: ADMIN_USERS_BULK_ROUTE_PERMISSIONS },
})
  .use(rateLimit({ limit: USERS_BULK_PREVIEW_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-users-bulk-preview' }))
  .post(
    asyncHandler(async (req, res) => {
      const { target, action } = AdminUsersBulkPreviewRequestSchema.parse(req.body);
      for (const permission of adminUsersBulkActionPermissions(action)) requireAdminPermission(req, permission);
      const cohort = await resolveAdminUsersBulk(target, selfIdsOf(req.user), usersBulkResolveDeps, new Date(), {
        actorIsFullAdmin: isFullAdmin(req.user),
      });
      const preview: AdminUsersBulkPreview = await previewAdminUsersBulk(cohort, action, usersBulkPreviewDeps);
      // The sample carries identities, so a provider-id filter resolves an account here too.
      const input =
        target.kind === 'filter'
          ? providerIdSearchAudit(target.filter.search, 'users_bulk_preview', {
              count: cohort.matched,
              sole:
                cohort.matched === 1 && preview.sample.length === 1
                  ? { id: preview.sample[0].id, displayName: preview.sample[0].email ?? preview.sample[0].id }
                  : undefined,
            })
          : null;
      if (input) await recordAdminActionFromRequest(req, input);
      return res.json(preview);
    })
  );

export default handler;
