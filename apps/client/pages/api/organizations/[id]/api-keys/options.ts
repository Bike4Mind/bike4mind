// GET /api/organizations/:id/api-keys/options
// What an admin may pick for an org-owned key: the scopes the ORG is entitled to (product gates judged
// on the org, never the caller) and the org's live groups for reach grants. Owner, current manager or
// platform admin (`manageKeys`), the same as the key routes it feeds.

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { orgApiKeyOptions } from '@server/organizations/orgApiKeys';
import { verifyOrgPermission } from '@bike4mind/server-utils/utils/orgAccess';

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, Awaited<ReturnType<typeof orgApiKeyOptions>>, unknown, { id?: string }>(async (req, res) => {
    const org = await verifyOrgPermission(
      req.user!,
      typeof req.query.id === 'string' ? req.query.id : '',
      'manageKeys'
    );
    return res.json(await orgApiKeyOptions(org.id));
  })
);

export default handler;
