// GET /api/organizations/:id/custom-mcp/connections
// Current members' own custom MCP connections in this org, each with the status the org policy
// implies. Read-only: a member manages their own connection. Owner, current manager or platform
// admin (verifyOrgAccess).

import { ApiKeyScope } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { getOrgCustomMcpPolicy, listOrgMemberConnections } from '@server/mcpConnections/orgPolicy';
import { verifyOrgAccess } from '@server/utils/orgAccess';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const org = await verifyOrgAccess(req.user!, typeof req.query.id === 'string' ? req.query.id : '');
    const { policy } = await getOrgCustomMcpPolicy(org.id);
    return res.json(await listOrgMemberConnections(org, policy));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
