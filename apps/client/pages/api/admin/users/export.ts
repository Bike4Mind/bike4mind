import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ADMIN_USERS_LIST_MAX, AdminUsersFilterSchema } from '@client/app/utils/adminUsersFilter';
import { exportAdminUsers } from '@server/admin/usersList/listAdminUsers';
import qs from 'qs';

/** The users list's CSV source: every user the filter matches, bounded server-side. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
})
  .use(rateLimit({ limit: 6, windowMs: 60_000, bucket: 'admin-users-export' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = AdminUsersFilterSchema.safeParse(
        qs.parse(req.query as Record<string, string>, { arrayLimit: ADMIN_USERS_LIST_MAX })
      );
      if (!parsed.success) {
        return res.status(400).json({
          message: 'Invalid query parameters',
          error: parsed.error.issues[0]?.message ?? 'Invalid query parameters',
          issues: parsed.error.issues,
        });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.json(await exportAdminUsers(parsed.data));
    })
  );

export default handler;
