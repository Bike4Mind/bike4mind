import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import { initializeSlackPackage } from '@bike4mind/server-utils/integrations/slack/slackPackageInit';
initializeSlackPackage();

import type { EventBridgeEvent } from 'aws-lambda';
import { withEventContext } from '@workers/utils/eventContext';
import { cacheRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import { processQuickAskInDM } from '@bike4mind/slack';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { SlackEvents } from '@bike4mind/server-utils/utils/eventBus';
import { claimQuickAskDelivery } from './slackQuickAskAdmission';

export const handler = async (raw: EventBridgeEvent<string, unknown>): Promise<void> => {
  // Each invocation retains its own envelope without changing every other event handler's contract.
  const processEvent = withEventContext(async (event, logger) => {
    const detail = SlackEvents.QuickAskRequested.schema.parse(event.properties);
    const { slackUserId, b4mUserId, question, workspaceId } = detail;
    const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceId);
    const botToken = workspace?.slackBotToken ? decryptToken(workspace.slackBotToken) : null;
    if (!workspace || !botToken) {
      logger.error('[Slack Quick Ask] Workspace or bot token unavailable', { workspaceId });
      return;
    }
    const canonicalWorkspaceId = workspace.id;
    if (
      !(await claimQuickAskDelivery(
        { ...detail, workspaceId: canonicalWorkspaceId },
        { id: raw.id, time: raw.time },
        cacheRepository
      ))
    ) {
      logger.info('[Slack Quick Ask] Skipped a duplicate request', { workspaceId });
      return;
    }
    await processQuickAskInDM(slackUserId, b4mUserId, question, botToken, canonicalWorkspaceId);
  });
  await processEvent(raw);
};
