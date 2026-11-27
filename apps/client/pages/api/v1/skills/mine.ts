/** GET /api/v1/skills/mine - the skills you own (or, with organization_id, an organization you manage), cursor-paginated. */
import { listMySkillsContract, NotFoundError, UnprocessableEntityError } from '@bike4mind/common';
import { skillRepository } from '@bike4mind/database';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { verifyOrgPermission } from '@bike4mind/server-utils/utils/orgAccess';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { toPublicSkillSummary } from '@server/skills/publicView';
import { publicAppUrl } from '@bike4mind/server-utils/utils/validators';

const CURSOR_SCOPE = 'v1.skills.mine';
// Bounds the skip a hand-made cursor can ask for (the cursor is unsigned).
const MAX_PAGE = 1000;

const handler = nextRouteForContract(listMySkillsContract).get(async (req, res) => {
  const { limit, cursor, q, organization_id } = req.validatedQuery;
  let page = 1;
  if (cursor !== undefined) {
    const parts = decodeCursor(cursor, CURSOR_SCOPE).split(':');
    page = Number(parts[0]);
    if (
      parts.length !== 2 ||
      !(Number.isSafeInteger(page) && page >= 2 && page <= MAX_PAGE) ||
      Number(parts[1]) !== limit
    ) {
      throw new UnprocessableEntityError('Invalid cursor');
    }
  }

  const user = { id: req.user.id, isAdmin: Boolean(req.user.isAdmin) };
  if (organization_id !== undefined) {
    if (!isValidObjectId(organization_id)) throw new NotFoundError('Organization not found');
    await verifyOrgPermission(user, organization_id, 'manageContent');
  }

  const result = await skillRepository.searchAccessible(
    user.id,
    q ?? '',
    { query: organization_id === undefined ? { userId: user.id } : { organizationId: organization_id } },
    { page, limit },
    { by: 'updatedAt', direction: 'desc' },
    organization_id === undefined ? undefined : { adminOrganizationIds: [organization_id] }
  );

  const appUrl = publicAppUrl(req);
  return res.json({
    data: result.data.map(skill => toPublicSkillSummary(skill, appUrl)),
    next_cursor: result.hasMore && page < MAX_PAGE ? encodeCursor(CURSOR_SCOPE, `${page + 1}:${limit}`) : null,
  });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
