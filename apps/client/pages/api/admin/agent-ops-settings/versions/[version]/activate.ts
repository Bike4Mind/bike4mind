import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { BadRequestError } from '@bike4mind/utils';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(async (req, res) => {
  if (!req.user!.isAdmin) {
    throw new BadRequestError('Admin access required');
  }

  const versionNumber = parseInt(req.query.version as string);

  if (isNaN(versionNumber)) {
    throw new BadRequestError('Invalid version number');
  }

  let updatedSettings;
  try {
    updatedSettings = await agentOpsSettingsRepository.activateMetaPromptVersion(versionNumber);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        throw new BadRequestError(error.message);
      }
    }
    throw error;
  }

  await recordAdminActionFromRequest(req, {
    action: 'settings.agent_ops.version_activated',
    target: { kind: 'settings', id: 'agent_ops', displayName: 'Agent Ops settings' },
    summary: `activated Agent Ops meta-prompt version ${versionNumber}`,
    details: { version: versionNumber },
  });
  res.json(updatedSettings);
});

export default handler;
