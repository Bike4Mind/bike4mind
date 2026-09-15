/**
 * GitHub Webhook Secret Regeneration API
 *
 * PATCH - Regenerate the webhook secret for an existing configuration
 */

import { McpServer } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { generateWebhookSecret } from '@server/integrations/github/webhookUtils';
import { Logger } from '@bike4mind/observability';
import { encryptToken } from '@server/security/tokenEncryption';

const logger = new Logger({ metadata: { service: 'github-webhook-config' } });

const handler = baseApi()
  /**
   * PATCH - Regenerate webhook secret
   *
   * Generates a new secret while preserving the routing token and other configuration.
   * Returns the new secret so the user can update their GitHub webhook configuration.
   */
  .patch(async (req, res) => {
    const { id } = req.query;

    const server = await McpServer.findById(id);
    if (!server) {
      throw new NotFoundError('MCP Server not found');
    }

    if (server.userId !== req.user.id) {
      throw new ForbiddenError('Not authorized to modify this MCP server');
    }

    const webhookConfig = server.metadata?.webhooks?.github;
    if (!webhookConfig) {
      throw new BadRequestError('No webhook configuration exists for this server');
    }

    const newSecret = generateWebhookSecret();

    // Defense-in-depth: scope the update to userId even though ownership was already checked above
    await McpServer.findOneAndUpdate(
      { _id: id, userId: req.user.id },
      { $set: { 'metadata.webhooks.github.secret': encryptToken(newSecret) } }
    );

    logger.info('GitHub webhook secret regenerated', {
      userId: req.user.id,
      serverId: id,
      action: 'regenerate_secret',
    });

    return res.status(200).json({
      secret: newSecret,
      message: 'Secret regenerated successfully. Update your GitHub webhook configuration with the new secret.',
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
