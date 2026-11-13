import { ApiKeyScope, ForbiddenError } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { usersBulkUndoDeps } from '@bike4mind/server-utils/admin/usersBulk/adapters';
import { assertCanRunUsersBulkAction } from '@server/admin/usersBulk/authorize';
import { undoAdminUsersBulk } from '@bike4mind/server-utils/admin/usersBulk/undo';
import {
  ADMIN_USERS_BULK_ACTION_PERMISSIONS,
  ADMIN_USERS_BULK_ROUTE_PERMISSIONS,
  AdminUsersBulkUndoRequestSchema,
  type AdminUsersBulkActionType,
  type AdminUsersBulkUndoResult,
} from '@bike4mind/server-utils/app/utils/adminUsersBulk';

const ONE_MINUTE_MS = 60_000;
export const USERS_BULK_UNDO_RATE_LIMIT = 10;

/**
 * Reverts a bulk batch inside its undo window. 403 for another admin's batch or one whose action the
 * admin may no longer take, 410 once the window has passed, 409 when the batch was already undone.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: ADMIN_USERS_BULK_ROUTE_PERMISSIONS },
})
  .use(rateLimit({ limit: USERS_BULK_UNDO_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-users-bulk-undo' }))
  .post(
    asyncHandler(async (req, res) => {
      const { batchId } = AdminUsersBulkUndoRequestSchema.parse(req.body);
      const result: AdminUsersBulkUndoResult = await undoAdminUsersBulk(
        batchId,
        req.user.id,
        usersBulkUndoDeps(req, req.logger),
        record => {
          if (!Object.hasOwn(ADMIN_USERS_BULK_ACTION_PERMISSIONS, record.action)) {
            throw new ForbiddenError('This bulk action cannot be undone here.');
          }
          assertCanRunUsersBulkAction(req, record.action as AdminUsersBulkActionType, {
            unblocks: Boolean(record.blockedDomains?.length),
          });
        }
      );
      return res.json(result);
    })
  );

export default handler;
