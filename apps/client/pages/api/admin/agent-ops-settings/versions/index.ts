import { canAccessAdmin } from '@bike4mind/common';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@client/server/middlewares/adminApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/utils';

const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  if (!canAccessAdmin(req.user)) {
    throw new ForbiddenError('Admin access required');
  }

  const settings = await agentOpsSettingsRepository.getSettings();

  if (!settings || !settings.versions) {
    return res.json([]);
  }

  // Return versions sorted by version number (descending)
  const sortedVersions = [...settings.versions].sort((a, b) => b.versionNumber - a.versionNumber);

  res.json(sortedVersions);
});

export default handler;
