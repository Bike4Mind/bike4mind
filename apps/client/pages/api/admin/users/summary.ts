import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { adminUsersSummary } from '@server/admin/usersList/listAdminUsers';

/** Account totals for the users list header and its built-in view tabs. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
})
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-users-summary' }))
  .get(
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await adminUsersSummary());
    })
  );

export default handler;
