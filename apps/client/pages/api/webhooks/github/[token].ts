/**
 * GitHub Webhook Endpoint with URL-based Routing
 *
 * This endpoint accepts the routing token in the URL path instead of a header,
 * which is required because GitHub webhooks don't support custom headers.
 *
 * URL format: POST /api/webhooks/github/{routingToken}
 *
 * Supports both:
 * - Per-user MCP server webhooks (existing)
 * - Organization-level webhooks with subscriber fan-out (new)
 *
 * Security-critical processing order (sync):
 * 1. Extract token from URL and headers
 * 2. Get raw body for signature verification
 * 3. Try org webhook config first, fall back to MCP server
 * 4. Validate signature using secret (decrypted via tokenEncryption)
 * 5. Check deduplication (claim event)
 * 6. Enqueue for async processing (with orgId for fan-out if org-level)
 * 7. Return 200 OK immediately (< 2 seconds)
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { connectDB, mcpServerRepository, orgWebhookConfigRepository } from '@bike4mind/database';
import { IOrgWebhookConfigDocument, IMongoDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { Config } from '@server/utils/config';
import { GitHubEvent } from '@server/integrations/github/GitHubEvent';
import { GitHubEventType, WebhookProcessingResult, isValidGitHubEventType } from '@server/integrations/github/types';
import {
  verifyGitHubSignature,
  getRawBody,
  PayloadTooLargeError,
  verifyGitHubPayloadTimestamp,
} from '@server/integrations/github/webhookUtils';
import { WebhookAuditLogger, extractWebhookMetadata } from '@server/integrations/github/WebhookAuditLogger';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { decryptToken } from '@server/security/tokenEncryption';
import { sendToQueue } from '@server/utils/sqs';
import { serializeError } from '@server/utils/serializeError';
import { randomUUID } from 'crypto';

// Disable body parsing to get raw body for signature verification
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<WebhookProcessingResult>) {
  const logger = new Logger({ metadata: { context: 'github-webhook' } });

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
      error: 'Only POST requests are accepted',
    });
  }

  try {
    // Connect to database first (required for repository operations)
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

    // 1. Extract routing token from URL path
    const routingToken = req.query.token as string;

    // Extract other headers
    const eventType = req.headers['x-github-event'] as string;
    const deliveryId = req.headers['x-github-delivery'] as string;
    const signature = req.headers['x-hub-signature-256'] as string;

    const integrationAuditLogger = IntegrationAuditLogger.create(
      {
        entityType: 'webhook',
        integrationName: 'github',
        action: `webhook_${eventType || 'unknown'}`,
        requestId: deliveryId || randomUUID().split('-')[0],
      },
      req
    );

    logger.debug('[GITHUB-WEBHOOK] Received webhook (URL routing)', {
      eventType,
      deliveryId,
      hasSignature: !!signature,
      hasRoutingToken: !!routingToken,
    });

    // Validate required headers
    if (!eventType || !deliveryId) {
      logger.warn('[GITHUB-WEBHOOK] Missing required headers', {
        hasEventType: !!eventType,
        hasDeliveryId: !!deliveryId,
      });
      integrationAuditLogger.failure('missing_headers');
      return res.status(400).json({
        success: false,
        message: 'Missing required headers',
        error: 'X-GitHub-Event and X-GitHub-Delivery headers are required',
      });
    }

    if (!routingToken) {
      logger.warn('[GITHUB-WEBHOOK] Missing routing token in URL');
      integrationAuditLogger.failure('missing_routing_token');
      return res.status(400).json({
        success: false,
        message: 'Missing routing token',
        error: 'Routing token is required in URL path',
      });
    }

    // 2. Get raw body for signature verification
    const rawBody = await getRawBody(req);
    const bodyString = rawBody.toString('utf8');

    // 3. Try org webhook config first, fall back to MCP server
    let webhookSecret: string;
    let isOrgWebhook = false;
    let orgConfig: (IOrgWebhookConfigDocument & IMongoDocument) | null = null;
    let mcpServer = null;

    // First, try to find org webhook config by routing token
    orgConfig = await orgWebhookConfigRepository.findByRoutingToken(routingToken);

    if (orgConfig) {
      isOrgWebhook = true;
      logger.debug('[GITHUB-WEBHOOK] Found org webhook config', {
        organizationId: orgConfig.organizationId,
      });

      if (!orgConfig.enabled) {
        logger.warn('[GITHUB-WEBHOOK] Org webhook is disabled', {
          organizationId: orgConfig.organizationId,
        });
        return res.status(403).json({
          success: false,
          message: 'Webhook disabled',
          error: 'Organization webhook is currently disabled',
        });
      }

      // Decrypt the org webhook secret
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
      if (!encryptionKey) {
        logger.error('[GITHUB-WEBHOOK] SECRET_ENCRYPTION_KEY not configured');
        return res.status(500).json({
          success: false,
          message: 'Server configuration error',
          error: 'Encryption key not configured',
        });
      }

      try {
        // Route through decryptToken() for key-rotation fallback: tries the current
        // SECRET_ENCRYPTION_KEY first, then SECRET_ENCRYPTION_KEY_PREVIOUS. This mirrors
        // the MCP path below and prevents a 500 retry storm when the key has been rotated
        // but this org's secret is still encrypted under the previous key.
        const decrypted = decryptToken(orgConfig.secret);
        if (!decrypted) {
          throw new Error('Org webhook secret is empty');
        }
        webhookSecret = decrypted;
      } catch (decryptError) {
        logger.error('[GITHUB-WEBHOOK] Failed to decrypt org webhook secret', {
          organizationId: orgConfig.organizationId,
          error: serializeError(decryptError),
        });
        return res.status(500).json({
          success: false,
          message: 'Server configuration error',
          error: 'Failed to decrypt webhook secret',
        });
      }
    } else {
      // Fall back to MCP server by routing token
      mcpServer = await mcpServerRepository.findByGitHubWebhookToken(routingToken);

      if (!mcpServer) {
        logger.warn('[GITHUB-WEBHOOK] Unknown routing token', {
          tokenPrefix: routingToken.substring(0, 8) + '...',
        });
        // Return 401 (not 404) to prevent routing token enumeration
        return res.status(401).json({
          success: false,
          message: 'Unauthorized',
          error: 'Invalid credentials',
        });
      }

      const webhookConfig = mcpServer.metadata?.webhooks?.github;

      if (!webhookConfig?.secret) {
        logger.error('[GITHUB-WEBHOOK] MCP server missing webhook secret', {
          mcpServerId: mcpServer.id,
        });
        return res.status(500).json({
          success: false,
          message: 'Webhook configuration error',
          error: 'MCP server webhook secret not configured',
        });
      }

      webhookSecret = decryptToken(webhookConfig.secret) ?? webhookConfig.secret;
    }

    // 4. Validate signature (SECURITY-CRITICAL)
    const signatureResult = verifyGitHubSignature(rawBody, signature, webhookSecret);

    if (!signatureResult.valid) {
      logger.warn('[GITHUB-WEBHOOK] Invalid signature', {
        error: signatureResult.error,
        deliveryId,
        isOrgWebhook,
        targetId: isOrgWebhook ? orgConfig?.organizationId : mcpServer?.id,
      });
      if (mcpServer) integrationAuditLogger.setUserId(mcpServer.userId);
      integrationAuditLogger.failure('invalid_signature');
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      });
    }

    // Parse payload after signature validation
    let payload;
    try {
      payload = JSON.parse(bodyString);
    } catch {
      logger.error('[GITHUB-WEBHOOK] Invalid JSON payload', { deliveryId });
      return res.status(400).json({
        success: false,
        message: 'Invalid payload',
        error: 'Request body is not valid JSON',
      });
    }

    // Best-effort payload timestamp check (log-only - payload timestamps are advisory, not signed)
    const timestampCheck = verifyGitHubPayloadTimestamp(payload);
    if (!timestampCheck.fresh) {
      logger.warn('[GITHUB-WEBHOOK] Stale payload timestamp detected', {
        source: timestampCheck.timestampSource,
        deliveryId,
        isOrgWebhook,
      });
    } else if (!timestampCheck.timestampSource) {
      logger.debug('[GITHUB-WEBHOOK] No verifiable timestamp in payload', {
        eventType,
        deliveryId,
      });
    }

    // Validate event type before caching/processing
    if (!isValidGitHubEventType(eventType)) {
      logger.warn('[GITHUB-WEBHOOK] Unsupported event type', {
        eventType,
        deliveryId,
      });
      return res.status(200).json({
        success: true,
        message: 'Event type not supported',
        deliveryId,
      });
    }

    // Extract metadata for audit logging
    const repository = (payload as { repository?: { full_name?: string } }).repository?.full_name || 'unknown';
    const sender = (payload as { sender?: { login?: string } }).sender?.login || 'unknown';

    // Create audit logger for this webhook
    const auditLogger = WebhookAuditLogger.create({
      deliveryId,
      event: eventType,
      repository,
      sender,
      signatureVerified: true,
      metadata: extractWebhookMetadata(payload),
      organizationId: isOrgWebhook ? orgConfig?.organizationId : undefined,
      mcpServerId: !isOrgWebhook && mcpServer ? mcpServer.id : undefined,
    });

    // Log webhook received (fire-and-forget)
    auditLogger.received();

    // 5. Create GitHubEvent and atomically claim for processing
    const githubEvent = new GitHubEvent(eventType as GitHubEventType, deliveryId, payload);
    const claimResult = await githubEvent.tryClaimForProcessing(logger, 'org');

    if (!claimResult.claimed) {
      logger.info('[GITHUB-WEBHOOK] Event already claimed/processed', {
        deliveryId,
        eventType,
      });
      return res.status(200).json({
        success: true,
        message: 'Event already processed',
        eventType: eventType as GitHubEventType,
        deliveryId,
      });
    }

    // 6. Enqueue for async processing
    // Use the correlationId from the audit logger for distributed tracing
    const correlationId = auditLogger.correlationId;

    try {
      if (isOrgWebhook && orgConfig) {
        // Org-level webhook: enqueue with orgId for fan-out to subscribers
        await sendToQueue(getSourceQueueUrl('githubWebhookQueue'), {
          deliveryId,
          eventType,
          payload,
          // Org webhook fields
          orgId: orgConfig.organizationId,
          isOrgWebhook: true,
          receivedAt: new Date().toISOString(),
          correlationId,
        });

        logger.info('[GITHUB-WEBHOOK] Org event enqueued for fan-out', {
          deliveryId,
          eventType,
          organizationId: orgConfig.organizationId,
          correlationId,
        });

        // Update lastDeliveryAt for org config
        await orgWebhookConfigRepository.updateLastDelivery(orgConfig.id);
      } else if (mcpServer) {
        // Per-user MCP server webhook: existing flow
        await sendToQueue(getSourceQueueUrl('githubWebhookQueue'), {
          deliveryId,
          eventType,
          payload,
          mcpServerId: mcpServer.id,
          userId: mcpServer.userId,
          receivedAt: new Date().toISOString(),
          correlationId,
        });

        logger.info('[GITHUB-WEBHOOK] Event enqueued for processing', {
          deliveryId,
          eventType,
          mcpServerId: mcpServer.id,
          correlationId,
        });
      }

      if (mcpServer) integrationAuditLogger.setUserId(mcpServer.userId);
      integrationAuditLogger.success({
        eventType,
        isOrgWebhook,
        correlationId,
        mcpServerId: mcpServer?.id,
        organizationId: orgConfig?.organizationId,
      });

      return res.status(200).json({
        success: true,
        message: 'Event accepted for processing',
        eventType: eventType as GitHubEventType,
        deliveryId,
      });
    } catch (enqueueError) {
      logger.error('[GITHUB-WEBHOOK] Failed to enqueue event', {
        error: enqueueError,
        deliveryId,
        eventType,
        isOrgWebhook,
      });

      // Update audit log to failed status (fire-and-forget)
      auditLogger.failed(enqueueError instanceof Error ? enqueueError : new Error('Failed to enqueue event'));
      if (mcpServer) integrationAuditLogger.setUserId(mcpServer.userId);
      integrationAuditLogger.failure('enqueue_failed');

      return res.status(500).json({
        success: false,
        message: 'Failed to queue event for processing',
        error: 'Internal server error',
      });
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logger.warn('[GITHUB-WEBHOOK] Payload too large', { error: error.message });
      return res.status(413).json({
        success: false,
        message: 'Payload too large',
        error: 'Request body exceeds maximum allowed size',
      });
    }

    logger.error('[GITHUB-WEBHOOK] Unexpected error', { error: serializeError(error) });
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: 'An unexpected error occurred',
    });
  }
}
