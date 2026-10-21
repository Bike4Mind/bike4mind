import type { VideoJobOutput } from '@bike4mind/common';
import { slackDevWorkspaceRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import type { SlackJobDeliveryDeps } from './slackJobDelivery';

const storageFor = (output: VideoJobOutput) =>
  output.location === 'files' ? getFilesStorage() : getGeneratedImageStorage();

export const createSlackJobDeliveryDeps = (logger: Logger): SlackJobDeliveryDeps => ({
  getSlackClient: async workspaceId => {
    const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceId);
    if (!workspace?.slackBotToken) return null;
    // Loaded on first use: only jobs requested from Slack need the Slack package, its server wiring and the
    // encryption key (tokenEncryption reads its secrets when the module loads).
    const [{ decryptToken }, { initializeSlackPackage }, { SlackClient }] = await Promise.all([
      import('@server/security/tokenEncryption'),
      import('@server/integrations/slack/slackPackageInit'),
      import('@bike4mind/slack'),
    ]);
    const token = decryptToken(workspace.slackBotToken);
    if (!token) return null;
    initializeSlackPackage();
    return new SlackClient(token, logger);
  },
  downloadOutput: output => storageFor(output).download(output.s3Key),
  signOutputUrl: (output, expiresInSeconds) =>
    storageFor(output).getSignedUrl(output.s3Key, 'get', { expiresIn: expiresInSeconds, audience: 'browser' }),
  logger,
});
