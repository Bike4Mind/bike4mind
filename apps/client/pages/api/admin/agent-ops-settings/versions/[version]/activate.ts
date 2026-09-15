import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';

const handler = baseApi().post(async (req, res) => {
  if (!req.user!.isAdmin) {
    throw new BadRequestError('Admin access required');
  }

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
