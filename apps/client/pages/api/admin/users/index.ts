import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ADMIN_USERS_LIST_MAX, AdminUsersQuerySchema } from '@bike4mind/server-utils/app/utils/adminUsersFilter';
import { adminUsersDomainGroups, listAdminUsers } from '@bike4mind/server-utils/admin/usersList/listAdminUsers';
import qs from 'qs';

/**
 * The admin users list: GET /api/admin/users. With `groupBy=emailDomain` it returns the email-domain
 * groups for the same filter instead of a page of users. The free-text search rides in the query
 * string here but never in the page URL, since it often holds an email.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
})
  .use(rateLimit({ limit: 120, windowMs: 60_000, bucket: 'admin-users-list' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = AdminUsersQuerySchema.safeParse(
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
      const { groupBy, ...params } = parsed.data;
      if (groupBy) return res.json(await adminUsersDomainGroups(params));
      const viewer = { userId: String(req.user.id), isAdmin: req.user.isAdmin === true };
      return res.json(
        await listAdminUsers(params, viewer, { logError: (message, error) => req.logger.error(message, error) })
      );
    })
  );

export default handler;
