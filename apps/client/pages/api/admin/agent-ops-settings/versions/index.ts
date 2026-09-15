import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/utils';

const handler = baseApi().get(async (req, res) => {
  if (!req.user!.isAdmin) {
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
