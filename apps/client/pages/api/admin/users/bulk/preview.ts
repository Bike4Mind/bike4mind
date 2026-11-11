import { ApiKeyScope, isFullAdmin } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi, requireAdminPermission } from '@server/middlewares/adminApi';
import { selfIdsOf } from '@server/admin/usersBulk/actor';
import { usersBulkPreviewDeps, usersBulkResolveDeps } from '@server/admin/usersBulk/adapters';
import { previewAdminUsersBulk, resolveAdminUsersBulk } from '@server/admin/usersBulk/resolve';
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
      return res.json(preview);
    })
  );

export default handler;
