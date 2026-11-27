import { adminApi } from '@server/middlewares/adminApi';
import { getOAuthClientUsageStats } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  res.status(200).json(await getOAuthClientUsageStats());
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
