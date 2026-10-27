import { slackDevWorkspaceRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { downloadServeableOutput, signOutputUrl } from '@server/generations/signOutputUrl';
import type { SlackJobDeliveryDeps } from './slackJobDelivery';

export const createSlackJobDeliveryDeps = (logger: Logger): SlackJobDeliveryDeps => ({
  getSlackClient: async workspaceId => {
    const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceId);
    if (!workspace?.slackBotToken) return null;
    // Loaded on first use: only jobs requested from Slack need the Slack package, its server wiring and the
    // encryption key (tokenEncryption reads its secrets when the module loads).
    const [{ decryptToken }, { initializeSlackPackage }, { SlackClient }] = await Promise.all([
      import('@bike4mind/server-utils/security/tokenEncryption'),
      import('@server/integrations/slack/slackPackageInit'),
      import('@bike4mind/slack'),
    ]);
    let token: string | null;
    try {
      token = decryptToken(workspace.slackBotToken);
    } catch (error) {
      // decryptToken throws on a wrong or rotated key.
      logger.warn('slack bot token could not be decrypted; skipping video delivery', { workspaceId, error });
      return null;
    }
    if (!token) return null;
    initializeSlackPackage();
    return new SlackClient(token, logger);
  },
  downloadOutput: downloadServeableOutput,
  signOutputUrl,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  logger,
});
