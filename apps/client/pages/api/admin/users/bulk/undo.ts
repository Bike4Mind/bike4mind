import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { usersBulkUndoDeps } from '@server/admin/usersBulk/adapters';
import { undoAdminUsersBulk } from '@server/admin/usersBulk/undo';
import { AdminUsersBulkUndoRequestSchema, type AdminUsersBulkUndoResult } from '@client/app/utils/adminUsersBulk';

const ONE_MINUTE_MS = 60_000;
export const USERS_BULK_UNDO_RATE_LIMIT = 10;

/**
 * Reverts a bulk batch inside its undo window. 403 for another admin's batch, 410 once the window has
 * passed, 409 when the batch was already undone.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: USERS_BULK_UNDO_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-users-bulk-undo' }))
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const { batchId } = AdminUsersBulkUndoRequestSchema.parse(req.body);
      const result: AdminUsersBulkUndoResult = await undoAdminUsersBulk(
        batchId,
        req.user.id,
        usersBulkUndoDeps(req, req.logger)
      );
      return res.json(result);
    })
  );

export default handler;
