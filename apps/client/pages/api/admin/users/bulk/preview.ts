import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { selfIdsOf } from '@server/admin/usersBulk/actor';
import { usersBulkPreviewDeps, usersBulkResolveDeps } from '@server/admin/usersBulk/adapters';
import { previewAdminUsersBulk, resolveAdminUsersBulk } from '@server/admin/usersBulk/resolve';
import { AdminUsersBulkPreviewRequestSchema, type AdminUsersBulkPreview } from '@client/app/utils/adminUsersBulk';

const ONE_MINUTE_MS = 60_000;
export const USERS_BULK_PREVIEW_RATE_LIMIT = 60;

/** Dry run of a users-list bulk action: what it would touch and change. Writes nothing. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: USERS_BULK_PREVIEW_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-users-bulk-preview' }))
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const { target, action } = AdminUsersBulkPreviewRequestSchema.parse(req.body);
      const cohort = await resolveAdminUsersBulk(target, selfIdsOf(req.user), usersBulkResolveDeps, new Date());
      const preview: AdminUsersBulkPreview = await previewAdminUsersBulk(cohort, action, usersBulkPreviewDeps);
      return res.json(preview);
    })
  );

export default handler;
