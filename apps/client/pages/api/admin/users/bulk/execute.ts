import { ApiKeyScope } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { selfIdsOf } from '@server/admin/usersBulk/actor';
import { usersBulkExecuteDeps } from '@server/admin/usersBulk/adapters';
import { executeAdminUsersBulk } from '@server/admin/usersBulk/execute';
import {
  AdminUsersBulkExecuteRequestSchema,
  blocksEmailDomains,
  type AdminUsersBulkResult,
} from '@client/app/utils/adminUsersBulk';

const ONE_MINUTE_MS = 60_000;
export const USERS_BULK_EXECUTE_RATE_LIMIT = 10;

/**
 * Runs a confirmed users-list bulk action: 400 over the cap, 409 when the eligible count no longer
 * matches `expectedCount` or the same idempotency key is still running, 403 when Contain blocks email
 * domains without permission to edit admin settings. One transaction per user.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: USERS_BULK_EXECUTE_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-users-bulk-execute' }))
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const request = AdminUsersBulkExecuteRequestSchema.parse(req.body);
      // Blocking domains writes blockedEmailDomains, so it needs the settings route's permission too.
      if (blocksEmailDomains(request.action) && !req.ability?.can('update', AdminSettings)) {
        throw new ForbiddenError('Blocking email domains needs permission to edit admin settings.');
      }
      const result: AdminUsersBulkResult = await executeAdminUsersBulk(
        request,
        { id: req.user.id, selfIds: selfIdsOf(req.user) },
        usersBulkExecuteDeps(req, request.reason, req.logger)
      );
      return res.json(result);
    })
  );

export default handler;
