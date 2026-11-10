import { ApiKeyScope, isFullAdmin } from '@bike4mind/common';
import type { Request } from 'express';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { selfIdsOf } from '@server/admin/usersBulk/actor';
import { usersBulkExecuteDeps } from '@server/admin/usersBulk/adapters';
import { assertCanRunUsersBulkAction } from '@server/admin/usersBulk/authorize';
import { requestUsersBulkApprovalIfNeeded } from '@server/admin/usersBulk/approvalGate';
import { executeAdminUsersBulk } from '@server/admin/usersBulk/execute';
import {
  ADMIN_USERS_BULK_ROUTE_PERMISSIONS,
  AdminUsersBulkExecuteRequestSchema,
  blocksEmailDomains,
  type AdminUsersBulkResult,
} from '@client/app/utils/adminUsersBulk';

const ONE_MINUTE_MS = 60_000;
export const USERS_BULK_EXECUTE_RATE_LIMIT = 10;

/**
 * Runs a confirmed users-list bulk action: 400 over the cap, 409 when the eligible count no longer
 * matches `expectedCount` or the same idempotency key is still running, 403 when Contain blocks email
 * domains without permission to edit admin settings. One transaction per user. 202 with an approval id
 * when approvals are on and the batch is over a threshold: nothing runs until a second admin approves.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: ADMIN_USERS_BULK_ROUTE_PERMISSIONS },
})
  .use(rateLimit({ limit: USERS_BULK_EXECUTE_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-users-bulk-execute' }))
  .post(
    asyncHandler(async (req, res) => {
      const request = AdminUsersBulkExecuteRequestSchema.parse(req.body);
      assertCanRunUsersBulkAction(req, request.action.type, { blocks: blocksEmailDomains(request.action) });
      const gate = await requestUsersBulkApprovalIfNeeded(req as unknown as Request, request);
      if (gate.pending) return res.status(202).json(gate.pending);
      try {
        const result: AdminUsersBulkResult = await executeAdminUsersBulk(
          request,
          {
            id: req.user.id,
            selfIds: selfIdsOf(req.user),
            fullAdmin: isFullAdmin(req.user),
            ...(gate.creditBalances ? { creditBalances: gate.creditBalances } : {}),
          },
          usersBulkExecuteDeps(req, request.reason, req.logger)
        );
        return res.json(result);
      } finally {
        await gate.release();
      }
    })
  );

export default handler;
