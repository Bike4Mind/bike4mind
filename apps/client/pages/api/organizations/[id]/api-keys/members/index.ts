// GET /api/organizations/:id/api-keys/members
// Members' own keys billed to the org, every status, newest first (server/organizations/orgMemberApiKeys.ts).
// Owner, current manager or platform admin (verifyOrgAccess).

import { type IOrgMemberApiKeyView } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { listOrgMemberKeys, resolveHolderNames, toOrgMemberApiKeyView } from '@server/organizations/orgMemberApiKeys';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';

const orgIdOf = (query: { id?: string }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, IOrgMemberApiKeyView[], unknown, { id?: string }>(async (req, res) => {
    const org = await verifyOrgAccess(req.user!, orgIdOf(req.query));
    const keys = await listOrgMemberKeys(org.id);
    const holderNames = await resolveHolderNames(keys);
    return res.json(keys.map(key => toOrgMemberApiKeyView(key, holderNames)));
  })
);

export default handler;
