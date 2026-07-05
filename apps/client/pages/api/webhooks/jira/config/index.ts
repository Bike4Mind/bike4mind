/**
 * Jira Webhook Configuration API
 *
 * Allows users to configure Jira webhooks for their connected Atlassian site.
 * Users manually create an admin webhook in Jira (Admin -> System -> Webhooks)
 * using the URL and secret generated here. Events are then routed to Slack
 * via subscriptions.
 *
 * Security:
 * - Requires valid Atlassian connection
 * - Secret is encrypted at rest using AES-256-GCM
 * - Routing token is unique per Atlassian cloud
 *
 * @route POST /api/webhooks/jira/config - Create webhook config
 * @route GET /api/webhooks/jira/config - Get config (secret masked)
 * @route PUT /api/webhooks/jira/config - Update config
 * @route DELETE /api/webhooks/jira/config - Delete config
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { jiraWebhookConfigRepository, jiraWebhookSubscriptionRepository } from '@bike4mind/database';
import {
  generateRoutingToken,
  generateWebhookSecret,
  ROTATION_WINDOW_MS,
} from '@server/integrations/jira/webhookUtils';
import { encryptSecret, decryptSecret } from '@server/security/secretEncryption';
import { Config } from '@server/utils/config';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import {
  IJiraWebhookConfigRequest,
  IJiraWebhookConfigResponse,
  JiraWebhookEventType,
  COMMON_JIRA_WEBHOOK_EVENTS,
} from '@bike4mind/common';
import {
  AtlassianTokenManager,
  AtlassianReconnectRequiredError,
} from '@server/integrations/jira/atlassianTokenManager';

/**
 * Mask the secret for display (show only last 4 characters)
 */
function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return '****';
  }
  return '*'.repeat(secret.length - 4) + secret.slice(-4);
}

/**
 * Get the webhook URL for this configuration
 */
function getWebhookUrl(routingToken: string): string {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  return `${baseUrl}/api/webhooks/jira/${routingToken}`;
}

const handler = baseApi()
  // POST - Create Jira webhook config
  .post(
    asyncHandler<object, IJiraWebhookConfigResponse, IJiraWebhookConfigRequest>(async (req, res) => {
      const user = req.user!;

      let tokens;
      try {
        tokens = await AtlassianTokenManager.getValidTokens(user.id);
      } catch (error) {
        if (error instanceof AtlassianReconnectRequiredError) {
          throw new UnauthorizedError('Your Atlassian connection has expired. Please reconnect your account.');
        }
        throw error;
      }
      if (!tokens) {
        throw new UnauthorizedError('Atlassian connection not found. Please connect your Atlassian account first.');
      }

      const { cloudId, siteUrl } = tokens;

      const existingConfig = await jiraWebhookConfigRepository.findByAtlassianCloudId(cloudId);
      if (existingConfig) {
        throw new BadRequestError('Webhook configuration already exists for this Atlassian site');
      }

      const { events = COMMON_JIRA_WEBHOOK_EVENTS, enabled = true } = req.body || {};

      if (!Array.isArray(events) || events.length === 0) {
        throw new BadRequestError('events must be a non-empty array');
      }

      const routingToken = generateRoutingToken();
      const secret = generateWebhookSecret();

      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error('SECRET_ENCRYPTION_KEY not configured');
      }

      const encryptedSecret = encryptSecret(secret, encryptionKey);
      const webhookUrl = getWebhookUrl(routingToken);

      // Create the DB config (user will manually configure the webhook in Jira Admin)
      const webhookConfig = await jiraWebhookConfigRepository.create({
        atlassianCloudId: cloudId,
        atlassianSiteUrl: siteUrl.replace('/wiki', ''),
        routingToken,
        secret: encryptedSecret,
        events: events as JiraWebhookEventType[],
        createdBy: user.id,
        enabled,
      });

      // Return response with plain secret (one-time reveal)
      const response: IJiraWebhookConfigResponse = {
        id: webhookConfig.id,
        atlassianCloudId: webhookConfig.atlassianCloudId,
        atlassianSiteUrl: webhookConfig.atlassianSiteUrl,
        routingToken: webhookConfig.routingToken,
        events: webhookConfig.events,
        createdBy: webhookConfig.createdBy,
        enabled: webhookConfig.enabled,
        lastDeliveryAt: webhookConfig.lastDeliveryAt,
        createdAt: webhookConfig.createdAt,
        updatedAt: webhookConfig.updatedAt,
        webhookUrl,
        secret, // Return plain secret on creation (one-time)
        secretMasked: maskSecret(secret),
      };

      return res.status(201).json(response);
    })
  )
  // GET - Get Jira webhook config
  .get(
    asyncHandler<object, IJiraWebhookConfigResponse | null, unknown, { revealSecret?: string }>(async (req, res) => {
      const user = req.user!;
      const revealSecret = req.query.revealSecret === 'true';

      let tokens;
      try {
        tokens = await AtlassianTokenManager.getValidTokens(user.id);
      } catch (error) {
        if (error instanceof AtlassianReconnectRequiredError) {
          throw new UnauthorizedError('Your Atlassian connection has expired. Please reconnect your account.');
        }
        throw error;
      }
      if (!tokens) {
        throw new UnauthorizedError('Atlassian connection not found. Please connect your Atlassian account first.');
      }

      const { cloudId } = tokens;

      // Find the config - return null if not configured yet (not an error)
      const webhookConfig = await jiraWebhookConfigRepository.findByAtlassianCloudId(cloudId);
      if (!webhookConfig) {
        return res.status(200).json(null);
      }

      const subscriberCount = await jiraWebhookSubscriptionRepository.countByWebhookConfig(webhookConfig.id);

      // Decrypt and optionally reveal secret
      let secretDisplay: string;
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;

      if (revealSecret && encryptionKey) {
        const decryptedSecret = decryptSecret(webhookConfig.secret, encryptionKey);
        secretDisplay = decryptedSecret;
      } else if (encryptionKey) {
        const decryptedSecret = decryptSecret(webhookConfig.secret, encryptionKey);
        secretDisplay = maskSecret(decryptedSecret);
      } else {
        secretDisplay = '****';
      }

      // Check if rotation is active
      const isRotating =
        !!webhookConfig.previousSecret &&
        !!webhookConfig.previousSecretExpiresAt &&
        new Date(webhookConfig.previousSecretExpiresAt) > new Date();

      const response: IJiraWebhookConfigResponse = {
        id: webhookConfig.id,
        atlassianCloudId: webhookConfig.atlassianCloudId,
        atlassianSiteUrl: webhookConfig.atlassianSiteUrl,
        routingToken: webhookConfig.routingToken,
        events: webhookConfig.events,
        createdBy: webhookConfig.createdBy,
        enabled: webhookConfig.enabled,
        lastDeliveryAt: webhookConfig.lastDeliveryAt,
        createdAt: webhookConfig.createdAt,
        updatedAt: webhookConfig.updatedAt,
        webhookUrl: getWebhookUrl(webhookConfig.routingToken),
        secret: revealSecret ? secretDisplay : undefined,
        secretMasked: revealSecret ? undefined : secretDisplay,
        subscriberCount,
        isRotating,
        previousSecretExpiresAt: isRotating ? webhookConfig.previousSecretExpiresAt : undefined,
      };

      return res.status(200).json(response);
    })
  )
  // PUT - Update Jira webhook config
  .put(
    asyncHandler<object, IJiraWebhookConfigResponse, Partial<IJiraWebhookConfigRequest>>(async (req, res) => {
      const user = req.user!;

      const tokens = await AtlassianTokenManager.getValidTokens(user.id);
      if (!tokens) {
        throw new UnauthorizedError('Atlassian connection not found. Please connect your Atlassian account first.');
      }

      const { cloudId } = tokens;

      // Find existing config
      const existingConfig = await jiraWebhookConfigRepository.findByAtlassianCloudId(cloudId);
      if (!existingConfig) {
        throw new NotFoundError('Webhook configuration not found');
      }

      // Only the creator can update
      if (existingConfig.createdBy !== user.id && !user.isAdmin) {
        throw new UnauthorizedError('Only the creator can update this webhook configuration');
      }

      const { events, enabled, rotateSecret } = req.body || {};

      const updates: Record<string, unknown> = {};
      let newPlainSecret: string | undefined;

      if (events !== undefined) {
        if (!Array.isArray(events) || events.length === 0) {
          throw new BadRequestError('events must be a non-empty array');
        }
        updates.events = events;
      }

      if (enabled !== undefined) {
        updates.enabled = enabled;
      }

      // Secret rotation: generate new secret, keep old one valid for 24h
      if (rotateSecret) {
        const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
        if (!encryptionKey) {
          throw new Error('SECRET_ENCRYPTION_KEY not configured');
        }

        newPlainSecret = generateWebhookSecret();
        const newEncryptedSecret = encryptSecret(newPlainSecret, encryptionKey);

        // Move current secret to previousSecret for the rotation window
        updates.previousSecret = existingConfig.secret; // already encrypted
        updates.previousSecretExpiresAt = new Date(Date.now() + ROTATION_WINDOW_MS).toISOString();
        updates.secret = newEncryptedSecret;
      }

      if (Object.keys(updates).length === 0) {
        throw new BadRequestError('No valid fields to update');
      }

      const updatedConfig = await jiraWebhookConfigRepository.update({
        ...existingConfig,
        ...updates,
      });

      if (!updatedConfig) {
        throw new Error('Failed to update webhook configuration');
      }

      const subscriberCount = await jiraWebhookSubscriptionRepository.countByWebhookConfig(updatedConfig.id);

      let secretMasked = '****';
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      if (encryptionKey) {
        const decryptedSecret = decryptSecret(updatedConfig.secret, encryptionKey);
        secretMasked = maskSecret(decryptedSecret);
      }

      // Check if rotation is active
      const isRotating =
        !!updatedConfig.previousSecret &&
        !!updatedConfig.previousSecretExpiresAt &&
        new Date(updatedConfig.previousSecretExpiresAt) > new Date();

      const response: IJiraWebhookConfigResponse = {
        id: updatedConfig.id,
        atlassianCloudId: updatedConfig.atlassianCloudId,
        atlassianSiteUrl: updatedConfig.atlassianSiteUrl,
        routingToken: updatedConfig.routingToken,
        events: updatedConfig.events,
        createdBy: updatedConfig.createdBy,
        enabled: updatedConfig.enabled,
        lastDeliveryAt: updatedConfig.lastDeliveryAt,
        createdAt: updatedConfig.createdAt,
        updatedAt: updatedConfig.updatedAt,
        webhookUrl: getWebhookUrl(updatedConfig.routingToken),
        // On rotation, reveal the new secret (one-time, like creation)
        secret: newPlainSecret,
        secretMasked: newPlainSecret ? maskSecret(newPlainSecret) : secretMasked,
        subscriberCount,
        isRotating,
        previousSecretExpiresAt: isRotating ? updatedConfig.previousSecretExpiresAt : undefined,
      };

      return res.status(200).json(response);
    })
  )
  // DELETE - Delete Jira webhook config
  .delete(
    asyncHandler<object, { success: boolean; message: string; deletedSubscriptions?: number }>(async (req, res) => {
      const user = req.user!;

      const tokens = await AtlassianTokenManager.getValidTokens(user.id);
      if (!tokens) {
        throw new UnauthorizedError('Atlassian connection not found. Please connect your Atlassian account first.');
      }

      const { cloudId } = tokens;

      // Find existing config
      const webhookConfig = await jiraWebhookConfigRepository.findByAtlassianCloudId(cloudId);
      if (!webhookConfig) {
        throw new NotFoundError('Webhook configuration not found');
      }

      // Only the creator or admin can delete
      if (webhookConfig.createdBy !== user.id && !user.isAdmin) {
        throw new UnauthorizedError('Only the creator can delete this webhook configuration');
      }

      // Cascade delete all subscriptions
      const deletedSubscriptions = await jiraWebhookSubscriptionRepository.deleteByWebhookConfig(webhookConfig.id);

      await jiraWebhookConfigRepository.delete(webhookConfig.id);

      return res.status(200).json({
        success: true,
        message:
          deletedSubscriptions > 0
            ? `Webhook configuration deleted. ${deletedSubscriptions} subscription(s) were also removed.`
            : 'Webhook configuration deleted successfully',
        deletedSubscriptions,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
