import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import { initializeSlackPackage } from '@bike4mind/server-utils/integrations/slack/slackPackageInit';
initializeSlackPackage();

import { withEventContext } from '@workers/utils/eventContext';
import { slackDevWorkspaceRepository } from '@bike4mind/database';
import { processQuickAskInDM } from '@bike4mind/slack';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { SlackEvents } from '@bike4mind/server-utils/utils/eventBus';

export const handler = withEventContext(async (event, logger) => {
  const { slackUserId, b4mUserId, question, workspaceId } = SlackEvents.QuickAskRequested.schema.parse(
    event.properties
  );

  const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceId);
  const botToken = workspace?.slackBotToken ? decryptToken(workspace.slackBotToken) : null;
  if (!botToken) {
    logger.error('[Slack Quick Ask] Workspace or bot token unavailable', { workspaceId });
    return;
  }

  await processQuickAskInDM(slackUserId, b4mUserId, question, botToken, workspaceId);
});
