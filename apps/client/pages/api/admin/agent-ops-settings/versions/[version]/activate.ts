import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@client/server/middlewares/adminApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).post(async (req, res) => {
  const versionNumber = parseInt(req.query.version as string);

  if (isNaN(versionNumber)) {
    throw new BadRequestError('Invalid version number');
  }

  try {
    const updatedSettings = await agentOpsSettingsRepository.activateMetaPromptVersion(versionNumber);
    res.json(updatedSettings);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        throw new BadRequestError(error.message);
      }
    }
    throw error;
  }
});

export default handler;
