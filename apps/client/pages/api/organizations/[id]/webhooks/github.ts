/**
 * Organization GitHub Webhook Configuration API
 *
 * Allows organization admins/managers to configure a shared GitHub webhook
 * that can be subscribed to by team members.
 *
 * Security:
 * - Requires user to have update access on the organization
 * - Secret is encrypted at rest using AES-256-GCM
 * - Routing token is unique per organization
 *
 * @route POST /api/organizations/[id]/webhooks/github - Create webhook config
 * @route GET /api/organizations/[id]/webhooks/github - Get config (secret masked)
 * @route PUT /api/organizations/[id]/webhooks/github - Update config
 * @route DELETE /api/organizations/[id]/webhooks/github - Delete config
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { orgWebhookConfigRepository } from '@bike4mind/database/infra';
import { webhookSubscriptionRepository } from '@bike4mind/database/infra';
import { generateWebhookToken, generateWebhookSecret } from '@server/integrations/github/webhookUtils';
import { encryptSecret, decryptSecret } from '@server/security/secretEncryption';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { Config } from '@server/utils/config';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { IOrgWebhookConfigRequest, IOrgWebhookConfigResponse } from '@bike4mind/common';

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
 * Get the webhook URL for this organization
 * Uses APP_URL environment variable to support forks with custom domains
 */
function getWebhookUrl(routingToken: string): string {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  return `${baseUrl}/api/webhooks/github/${routingToken}`;
}

const handler = baseApi()
  // POST - Create organization webhook config
  .post(
    asyncHandler<{}, IOrgWebhookConfigResponse, IOrgWebhookConfigRequest, { id?: string }>(async (req, res) => {
      const orgId = req.query.id!;
      const user = req.user!;

      await verifyOrgAccess(user, orgId);

      const existingConfig = await orgWebhookConfigRepository.findByOrganizationId(orgId);
      if (existingConfig) {
        throw new BadRequestError('Webhook configuration already exists for this organization');
      }

      // Validate request body
      const { repos = [], subscribedEvents = [] } = req.body || {};

      if (!Array.isArray(repos)) {
        throw new BadRequestError('repos must be an array');
      }

      if (!Array.isArray(subscribedEvents)) {
        throw new BadRequestError('subscribedEvents must be an array');
      }

      const routingToken = generateWebhookToken();
      const secret = generateWebhookSecret();

      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error('SECRET_ENCRYPTION_KEY not configured');
      }

      const encryptedSecret = encryptSecret(secret, encryptionKey);

      const webhookConfig = await orgWebhookConfigRepository.create({
        organizationId: orgId,
        routingToken,
        secret: encryptedSecret,
        repos,
        subscribedEvents,
        createdBy: user.id,
        enabled: true,
      });

      // Return response with plain secret (one-time reveal)
      const response: IOrgWebhookConfigResponse = {
        id: webhookConfig.id,
        organizationId: webhookConfig.organizationId,
        routingToken: webhookConfig.routingToken,
        repos: webhookConfig.repos,
        subscribedEvents: webhookConfig.subscribedEvents,
        createdBy: webhookConfig.createdBy,
        enabled: webhookConfig.enabled,
        lastDeliveryAt: webhookConfig.lastDeliveryAt,
        createdAt: webhookConfig.createdAt,
        updatedAt: webhookConfig.updatedAt,
        webhookUrl: getWebhookUrl(routingToken),
        secret, // Return plain secret on creation (one-time)
        secretMasked: maskSecret(secret),
      };

      return res.status(201).json(response);
    })
  )
  // GET - Get organization webhook config
  .get(
    asyncHandler<{}, IOrgWebhookConfigResponse, unknown, { id?: string; revealSecret?: string }>(async (req, res) => {
      const orgId = req.query.id!;
      const user = req.user!;
      const revealSecret = req.query.revealSecret === 'true';

      await verifyOrgAccess(user, orgId);

      const webhookConfig = await orgWebhookConfigRepository.findByOrganizationId(orgId);
      if (!webhookConfig) {
        throw new NotFoundError('Webhook configuration not found');
      }

      const subscriberCount = await webhookSubscriptionRepository.countByOrganization(orgId);

      // Decrypt and optionally reveal secret
      let secretDisplay: string;
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;

      if (revealSecret && encryptionKey) {
        // Reveal the actual secret (for copying to GitHub)
        const decryptedSecret = decryptSecret(webhookConfig.secret, encryptionKey);
        secretDisplay = decryptedSecret;
      } else if (encryptionKey) {
        // Show masked version
        const decryptedSecret = decryptSecret(webhookConfig.secret, encryptionKey);
        secretDisplay = maskSecret(decryptedSecret);
      } else {
        secretDisplay = '****';
      }

      const response: IOrgWebhookConfigResponse = {
        id: webhookConfig.id,
        organizationId: webhookConfig.organizationId,
        routingToken: webhookConfig.routingToken,
        repos: webhookConfig.repos,
        subscribedEvents: webhookConfig.subscribedEvents,
        createdBy: webhookConfig.createdBy,
        enabled: webhookConfig.enabled,
        lastDeliveryAt: webhookConfig.lastDeliveryAt,
        createdAt: webhookConfig.createdAt,
        updatedAt: webhookConfig.updatedAt,
        webhookUrl: getWebhookUrl(webhookConfig.routingToken),
        secret: revealSecret ? secretDisplay : undefined,
        secretMasked: revealSecret ? undefined : secretDisplay,
        subscriberCount,
      };

      return res.status(200).json(response);
    })
  )
  // PUT - Update organization webhook config
  .put(
    asyncHandler<{}, IOrgWebhookConfigResponse, Partial<IOrgWebhookConfigRequest>, { id?: string }>(
      async (req, res) => {
        const orgId = req.query.id!;
        const user = req.user!;

        await verifyOrgAccess(user, orgId);

        const existingConfig = await orgWebhookConfigRepository.findByOrganizationId(orgId);
        if (!existingConfig) {
          throw new NotFoundError('Webhook configuration not found');
        }

        const { repos, subscribedEvents, enabled } = req.body || {};

        // Update allowed fields
        const updates: Record<string, unknown> = {};

        if (repos !== undefined) {
          if (!Array.isArray(repos)) {
            throw new BadRequestError('repos must be an array');
          }
          updates.repos = repos;
        }

        if (subscribedEvents !== undefined) {
          if (!Array.isArray(subscribedEvents)) {
            throw new BadRequestError('subscribedEvents must be an array');
          }
          updates.subscribedEvents = subscribedEvents;
        }

        if (enabled !== undefined) {
          updates.enabled = enabled;
        }

        if (Object.keys(updates).length === 0) {
          throw new BadRequestError('No valid fields to update');
        }

        const updatedConfig = await orgWebhookConfigRepository.update({
          ...existingConfig,
          ...updates,
        });

        if (!updatedConfig) {
          throw new Error('Failed to update webhook configuration');
        }

        const subscriberCount = await webhookSubscriptionRepository.countByOrganization(orgId);

        let secretMasked = '****';
        const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
        if (encryptionKey) {
          const decryptedSecret = decryptSecret(updatedConfig.secret, encryptionKey);
          secretMasked = maskSecret(decryptedSecret);
        }

        const response: IOrgWebhookConfigResponse = {
          id: updatedConfig.id,
          organizationId: updatedConfig.organizationId,
          routingToken: updatedConfig.routingToken,
          repos: updatedConfig.repos,
          subscribedEvents: updatedConfig.subscribedEvents,
          createdBy: updatedConfig.createdBy,
          enabled: updatedConfig.enabled,
          lastDeliveryAt: updatedConfig.lastDeliveryAt,
          createdAt: updatedConfig.createdAt,
          updatedAt: updatedConfig.updatedAt,
          webhookUrl: getWebhookUrl(updatedConfig.routingToken),
          secretMasked,
          subscriberCount,
        };

        return res.status(200).json(response);
      }
    )
  )
  // DELETE - Delete organization webhook config
  .delete(
    asyncHandler<{}, { success: boolean; message: string; deletedSubscriptions?: number }, unknown, { id?: string }>(
      async (req, res) => {
        const orgId = req.query.id!;
        const user = req.user!;

        await verifyOrgAccess(user, orgId);

        const webhookConfig = await orgWebhookConfigRepository.findByOrganizationId(orgId);
        if (!webhookConfig) {
          throw new NotFoundError('Webhook configuration not found');
        }

        // Cascade delete: also remove all subscriptions for this organization
        const deletedSubscriptions = await webhookSubscriptionRepository.deleteByOrganization(orgId);

        await orgWebhookConfigRepository.delete(webhookConfig.id);

        return res.status(200).json({
          success: true,
          message:
            deletedSubscriptions > 0
              ? `Webhook configuration deleted. ${deletedSubscriptions} subscription(s) were also removed.`
              : 'Webhook configuration deleted successfully',
          deletedSubscriptions,
        });
      }
    )
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
