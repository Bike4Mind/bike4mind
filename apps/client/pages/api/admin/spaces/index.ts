import { z } from 'zod';
import { ApiKeyScope } from '@bike4mind/common';
import { orgDomainClaimRepository, spaceRepository, userRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { assertFullAdminForSpaces } from '@server/spaces/adminSpaces';

const QuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', 'name']).default('createdAt'),
});

/**
 * The platform admin Space list: GET /api/admin/spaces. The search text rides in the query string but
 * never in the page URL, since it may hold an email. Not gated on the Spaces flag, so an admin can still
 * find and delete a Space when the feature is off.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'users:moderate' },
})
  .use(rateLimit({ limit: 120, windowMs: 60_000, bucket: 'admin-spaces-list' }))
  .get(
    asyncHandler(async (req, res) => {
      assertFullAdminForSpaces(req.user);
      const { search, page, limit, sort } = QuerySchema.parse(req.query);

      // A search term can also name the owner, by exact email or username.
      const owners = search ? await userRepository.findAllByEmailsOrUsernames([search.toLowerCase()], [search]) : [];
      const { data, total } = await spaceRepository.searchAll({
        search,
        ownerUserIds: owners.map(owner => owner.id),
        page,
        limit,
        sort,
      });

      const ownerIds = [...new Set(data.map(space => space.ownerUserId))];
      const [users, domainCounts] = await Promise.all([
        userRepository.findByIds(ownerIds),
        Promise.all(data.map(space => orgDomainClaimRepository.countBySpace(space.id))),
      ]);
      const byId = new Map(users.map(user => [user.id, user]));

      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({
        total,
        page,
        limit,
        spaces: data.map((space, index) => {
          const owner = byId.get(space.ownerUserId);
          return {
            id: space.id,
            name: space.name,
            owner: { id: space.ownerUserId, username: owner?.username ?? null, email: owner?.email ?? null },
            memberCount: space.members.length + 1,
            domainCount: domainCounts[index],
            parentOrganizationId: space.parentOrganizationId ?? null,
            createdAt: space.createdAt,
          };
        }),
      });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
