import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { adminUsersSummary } from '@server/admin/usersList/listAdminUsers';

/** Account totals for the users list header and its built-in view tabs. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-users-summary' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await adminUsersSummary());
    })
  );

export default handler;
