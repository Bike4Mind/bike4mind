import { ApiKeyScope } from '@bike4mind/common';
import { adminSettingsRepository, agentRepository } from '@bike4mind/database';
import { ForbiddenError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { presentAgentsForViewer } from '@server/agents/presentAgentsForViewer';

const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).get(async (req, res) => {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['voiceV2Enabled'] });

  if (!getSettingsValue('voiceV2Enabled', settings)) {
    throw new ForbiddenError('Voice v2 is not enabled');
  }

  // Public voice agents are listed to every caller, so non-owners get the viewer allowlist.
  const agents = await agentRepository.listPublicVoiceAgents();
  return res.status(200).json({ agents: await presentAgentsForViewer(agents, req.user!.id) });
});

export default handler;
