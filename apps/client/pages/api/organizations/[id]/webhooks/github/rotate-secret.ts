/**
 * Organization Webhook Secret Rotation API
 *
 * Rotates the webhook secret for an organization's GitHub webhook configuration.
 * Returns the new secret (one-time reveal) so it can be updated in GitHub.
 *
 * Security:
 * - Requires user to have update access on the organization
 * - Logs secret rotation for audit trail
 *
 * @route POST /api/organizations/[id]/webhooks/github/rotate-secret - Rotate secret
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { orgWebhookConfigRepository } from '@bike4mind/database/infra';
import { webhookSubscriptionRepository } from '@bike4mind/database/infra';
import { generateWebhookSecret } from '@server/integrations/github/webhookUtils';
import { encryptSecret } from '@server/security/secretEncryption';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { Config } from '@server/utils/config';
import { NotFoundError, TooManyRequestsError } from '@bike4mind/utils';
import { cacheRepository } from '@bike4mind/database';
import { IOrgWebhookConfigResponse } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * Mask the secret for display
 */
function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return '****';
  }
  return '*'.repeat(secret.length - 4) + secret.slice(-4);
}

// Rate limit: 3 secret rotations per hour per organization (security-sensitive)
const RATE_LIMIT = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get the webhook URL for this organization
 * Uses APP_URL environment variable to support forks with custom domains
 */
function getWebhookUrl(routingToken: string): string {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  return `${baseUrl}/api/webhooks/github/${routingToken}`;
}

const handler = baseApi().post(
  asyncHandler<{}, IOrgWebhookConfigResponse, unknown, { id?: string }>(async (req, res) => {
    const orgId = req.query.id!;
    const user = req.user!;

    // Rate limit check (atomic) - secret rotation is security-sensitive
    const rateLimitKey = `webhook-rotate-secret-rate:${orgId}`;
    const rateLimitResult = await cacheRepository.incrementCounterConditional(
      rateLimitKey,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS
    );
    if (!rateLimitResult.success) {
      throw new TooManyRequestsError(
        `Rate limit exceeded. Maximum ${RATE_LIMIT} secret rotations per hour per organization.`
      );
    }

    await verifyOrgAccess(user, orgId);

    const existingConfig = await orgWebhookConfigRepository.findByOrganizationId(orgId);
    if (!existingConfig) {
      throw new NotFoundError('Webhook configuration not found');
    }

    const newSecret = generateWebhookSecret();

    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error('SECRET_ENCRYPTION_KEY not configured');
    }

    const encryptedSecret = encryptSecret(newSecret, encryptionKey);

    const updatedConfig = await orgWebhookConfigRepository.update({
      ...existingConfig,
      secret: encryptedSecret,
    });

    if (!updatedConfig) {
      throw new Error('Failed to update webhook configuration');
    }

    // Audit trail for a security-sensitive action
    Logger.info('[WEBHOOK-SECRET-ROTATION] Secret rotated', {
      organizationId: orgId,
      userId: user.id,
      timestamp: new Date().toISOString(),
    });

    const subscriberCount = await webhookSubscriptionRepository.countByOrganization(orgId);

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
      secret: newSecret, // Return plain secret on rotation (one-time reveal only)
      secretMasked: maskSecret(newSecret),
      subscriberCount,
    };

    // Prevent caching of response containing secret
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.status(200).json(response);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
