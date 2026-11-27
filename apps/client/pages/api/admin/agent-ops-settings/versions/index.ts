import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@client/server/middlewares/adminApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const settings = await agentOpsSettingsRepository.getSettings();

  if (!settings || !settings.versions) {
    return res.json([]);
  }

  // Return versions sorted by version number (descending)
  const sortedVersions = [...settings.versions].sort((a, b) => b.versionNumber - a.versionNumber);

  res.json(sortedVersions);
});

export default handler;
