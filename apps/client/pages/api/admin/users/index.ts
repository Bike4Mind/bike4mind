import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ADMIN_USERS_LIST_MAX, AdminUsersQuerySchema } from '@bike4mind/server-utils/app/utils/adminUsersFilter';
import { adminUsersDomainGroups, listAdminUsers } from '@bike4mind/server-utils/admin/usersList/listAdminUsers';
import { PROVIDER_END_USER_ID } from '@bike4mind/server-utils/admin/usersList/adminUsersQuery';
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
      const providerEndUserId = params.search && PROVIDER_END_USER_ID.test(params.search) ? params.search : null;
      const audit = (matched?: { id: string; displayName: string }[]) =>
        recordAdminActionFromRequest(req, {
          action: 'user.provider_id.resolved',
          target:
            matched?.length === 1
              ? { kind: 'user', id: matched[0].id, displayName: matched[0].displayName }
              : { kind: 'system', id: 'provider-end-user-id', displayName: 'Provider end-user identifier' },
          summary: 'Searched the users list by provider end-user identifier',
          details: {
            providerEndUserId: providerEndUserId?.toLowerCase(),
            source: 'users_list',
            ...(matched && { matched: matched.length > 0, matchedCount: matched.length }),
          },
        });
      if (groupBy) {
        const groups = await adminUsersDomainGroups(params);
        if (providerEndUserId) await audit();
        return res.json(groups);
      }
      const viewer = { userId: String(req.user.id), isAdmin: req.user.isAdmin === true };
      const list = await listAdminUsers(params, viewer, {
        logError: (message, error) => req.logger.error(message, error),
      });
      if (providerEndUserId) {
        await audit(list.users.map(row => ({ id: row.id, displayName: row.email ?? row.username })));
      }
      return res.json(list);
    })
  );

export default handler;
