import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ADMIN_USERS_LIST_MAX, AdminUsersQuerySchema } from '@bike4mind/server-utils/app/utils/adminUsersFilter';
import { adminUsersDomainGroups, listAdminUsers } from '@bike4mind/server-utils/admin/usersList/listAdminUsers';
import { providerIdSearchAudit } from '@bike4mind/server-utils/admin/usersList/providerIdSearchAudit';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
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
      const audit = async (matches?: Parameters<typeof providerIdSearchAudit>[2]) => {
        const input = providerIdSearchAudit(params.search, 'users_list', matches);
        if (input) await recordAdminActionFromRequest(req, input);
      };
      if (groupBy) {
        const groups = await adminUsersDomainGroups(params);
        await audit();
        return res.json(groups);
      }
      const viewer = { userId: String(req.user.id), isAdmin: req.user.isAdmin === true };
      const list = await listAdminUsers(params, viewer, {
        logError: (message, error) => req.logger.error(message, error),
      });
      const [only] = list.users;
      await audit({
        count: list.totalUsers,
        sole:
          list.totalUsers === 1 && list.users.length === 1
            ? { id: only.id, displayName: only.email ?? only.username }
            : undefined,
      });
      return res.json(list);
    })
  );

export default handler;
