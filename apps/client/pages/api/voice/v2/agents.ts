import { adminSettingsRepository, agentRepository } from '@bike4mind/database';
import { ForbiddenError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(async (_req, res) => {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['voiceV2Enabled'] });

  if (!getSettingsValue('voiceV2Enabled', settings)) {
    throw new ForbiddenError('Voice v2 is not enabled');
  }

  const agents = await agentRepository.listPublicVoiceAgents();
  return res.status(200).json({ agents });
});

export default handler;
