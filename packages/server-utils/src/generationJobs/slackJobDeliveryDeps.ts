import { slackDevWorkspaceRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { downloadServeableOutput, signOutputUrl } from '../generations/signOutputUrl';
import type { SlackJobDeliveryDeps } from './slackJobDelivery';
import { buildFileLinkUrl } from '../files/fileLinkToken';

export const createSlackJobDeliveryDeps = (logger: Logger): SlackJobDeliveryDeps => ({
  getSlackClient: async workspaceId => {
    const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceId);
    if (!workspace?.slackBotToken) return null;
    // Loaded on first use: only jobs requested from Slack need the Slack package, its server wiring and the
    // encryption key (tokenEncryption reads its secrets when the module loads).
    const [{ decryptToken }, { initializeSlackPackage }, { SlackClient }] = await Promise.all([
      import('../security/tokenEncryption'),
      import('../integrations/slack/slackPackageInit'),
      import('@bike4mind/slack'),
    ]);
    let token: string | null;
    try {
      token = decryptToken(workspace.slackBotToken);
    } catch (error) {
      // decryptToken throws on a wrong or rotated key.
      logger.warn('slack bot token could not be decrypted; skipping Slack delivery', { workspaceId, error });
      return null;
    }
    if (!token) return null;
    initializeSlackPackage();
    return new SlackClient(token, logger);
  },
  downloadOutput: downloadServeableOutput,
  signOutputUrl,
  buildOutputLink: (output, userId, ttlSeconds) => {
    if (output.location === 'generated')
      return buildFileLinkUrl({ kind: 'generatedKey', key: output.s3Key }, userId, ttlSeconds);
    return output.fileId ? buildFileLinkUrl({ kind: 'fabFile', fileId: output.fileId }, userId, ttlSeconds) : null;
  },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  logger,
});
