/**
 * GitHub Webhook Configuration API
 *
 * Endpoints for configuring GitHub webhook integration on MCP servers.
 *
 * POST - Create or update webhook configuration
 * GET - Get current webhook configuration (secret masked)
 * DELETE - Remove webhook configuration
 */

import { z } from 'zod';
import { requireEnv } from '@bike4mind/common';
import { McpServer } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { generateWebhookToken, generateWebhookSecret } from '@server/integrations/github/webhookUtils';
import { SUPPORTED_GITHUB_EVENTS, isValidGitHubEventType } from '@server/integrations/github/types';
import { Logger } from '@bike4mind/observability';
import { encryptToken, decryptToken } from '@server/security/tokenEncryption';

const logger = new Logger({ metadata: { service: 'github-webhook-config' } });

/**
 * Validation schema for webhook configuration
 */
const ConfigureWebhookSchema = z.object({
  subscribedEvents: z
    .array(z.string())
    .min(1, 'At least one event is required')
    .max(20, 'Maximum 20 events allowed')
    .refine(events => events.every(e => isValidGitHubEventType(e)), {
      message: `Invalid event type. Supported: ${SUPPORTED_GITHUB_EVENTS.join(', ')}`,
    }),
  repos: z
    .array(z.string())
    .min(1, 'At least one repository is required')
    .max(50, 'Maximum 50 repositories allowed')
    .refine(repos => repos.every(r => /^[^/]+\/[^/]+$/.test(r)), {
      error: 'Repositories must be in owner/repo format',
    }),
});

/**
 * Mask a secret for display, showing only last 4 characters
 */
function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return '****';
  }
  return '****' + secret.slice(-4);
}

/**
 * Get the webhook URL with routing token embedded in the path
 *
 * GitHub webhooks don't support custom headers, so we embed the routing token
 * in the URL path instead of using X-Webhook-Token header.
 */
function getWebhookUrl(routingToken: string): string {
  const baseUrl = requireEnv('APP_URL', process.env.APP_URL);
  return `${baseUrl}/api/webhooks/github/${routingToken}`;
}

const handler = baseApi()
  /**
   * POST - Create or update webhook configuration
   *
   * Creates a new webhook configuration or updates an existing one.
   * Returns the secret only on creation (201), not on update (200).
   */
  .post(async (req, res) => {
    const { id } = req.query;

    const server = await McpServer.findById(id);
    if (!server) {
      throw new NotFoundError('MCP Server not found');
    }

    if (server.userId !== req.user.id) {
      throw new ForbiddenError('Not authorized to modify this MCP server');
    }

    if (server.name !== 'github') {
      throw new BadRequestError('Webhook configuration is only available for GitHub MCP servers');
    }

    const parseResult = ConfigureWebhookSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError('Invalid request body', {
        errors: parseResult.error.issues.map(e => e.message),
      });
    }

    const { subscribedEvents, repos } = parseResult.data;

    // Repos must be from the user's already-connected GitHub repositories
    const selectedRepos = server.metadata?.selectedRepositories || [];
    const selectedFullNames = new Set(selectedRepos.map(r => r.fullName));
    const invalidRepos = repos.filter(repo => !selectedFullNames.has(repo));

    if (invalidRepos.length > 0) {
      throw new BadRequestError('Repositories must be from your connected GitHub repositories', {
        invalidRepos,
        availableRepos: Array.from(selectedFullNames),
      });
    }

    const existingConfig = server.metadata?.webhooks?.github;
    const isNewConfig = !existingConfig;

    // Generate tokens for new config, or preserve existing
    const routingToken = existingConfig?.routingToken || generateWebhookToken();
    const plaintextSecret =
      isNewConfig || !existingConfig!.secret
        ? generateWebhookSecret()
        : (decryptToken(existingConfig!.secret) ?? existingConfig!.secret);
    const encryptedSecret = encryptToken(plaintextSecret)!;
    const createdAt = existingConfig?.createdAt || new Date().toISOString();

    // Update the server with webhook configuration (defense-in-depth: include userId)
    const updatedServer = await McpServer.findOneAndUpdate(
      { _id: id, userId: req.user.id },
      {
        $set: {
          'metadata.webhooks.github': {
            routingToken,
            secret: encryptedSecret,
            subscribedEvents,
            repos,
            createdAt,
            lastDeliveryAt: existingConfig?.lastDeliveryAt,
          },
        },
      },
      { new: true }
    );

    logger.info('GitHub webhook config updated', {
      userId: req.user.id,
      serverId: id,
      action: isNewConfig ? 'create' : 'update',
      subscribedEvents,
      repos,
    });

    // URL includes routing token since GitHub webhooks don't support custom headers
    const response = {
      webhookUrl: getWebhookUrl(routingToken),
      subscribedEvents,
      repos,
      createdAt,
      lastDeliveryAt: updatedServer?.metadata?.webhooks?.github?.lastDeliveryAt,
      instructions:
        'Configure a webhook in your GitHub repository settings with this URL and secret. ' +
        'The routing token is already embedded in the URL - no custom headers required.',
    };

    if (isNewConfig) {
      return res.status(201).json({
        ...response,
        secret: plaintextSecret,
      });
    }

    return res.status(200).json({
      ...response,
      secretMasked: maskSecret(plaintextSecret),
    });
  })

  /**
   * GET - Get current webhook configuration
   *
   * Returns the current webhook configuration with the secret masked.
   */
  .get(async (req, res) => {
    const { id } = req.query;

    const server = await McpServer.findById(id);
    if (!server) {
      throw new NotFoundError('MCP Server not found');
    }

    if (server.userId !== req.user.id) {
      throw new ForbiddenError('Not authorized to view this MCP server');
    }

    const webhookConfig = server.metadata?.webhooks?.github;
    if (!webhookConfig) {
      return res.status(200).json({
        configured: false,
      });
    }

    return res.status(200).json({
      configured: true,
      webhookUrl: getWebhookUrl(webhookConfig.routingToken),
      secretMasked: maskSecret(decryptToken(webhookConfig.secret) ?? ''),
      subscribedEvents: webhookConfig.subscribedEvents,
      repos: webhookConfig.repos,
      createdAt: webhookConfig.createdAt,
      lastDeliveryAt: webhookConfig.lastDeliveryAt,
    });
  })

  /**
   * DELETE - Remove webhook configuration
   *
   * Removes the webhook configuration from the MCP server.
   */
  .delete(async (req, res) => {
    const { id } = req.query;

    const server = await McpServer.findById(id);
    if (!server) {
      throw new NotFoundError('MCP Server not found');
    }

    if (server.userId !== req.user.id) {
      throw new ForbiddenError('Not authorized to modify this MCP server');
    }

    if (!server.metadata?.webhooks?.github) {
      return res.status(204).end();
    }

    // Defense-in-depth: scope the update to userId even though ownership was already checked above
    await McpServer.findOneAndUpdate({ _id: id, userId: req.user.id }, { $unset: { 'metadata.webhooks.github': 1 } });

    logger.info('GitHub webhook config deleted', {
      userId: req.user.id,
      serverId: id,
      action: 'delete',
    });

    return res.status(204).end();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
