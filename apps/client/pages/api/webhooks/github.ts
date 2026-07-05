/**
 * GitHub Webhook Endpoint
 *
 * Receives GitHub webhook events, validates them, and enqueues for async processing.
 *
 * Security-critical processing order (sync):
 * 1. Extract headers and raw body
 * 2. Find MCP server by routing token
 * 3. Validate signature using MCP server's secret
 * 4. Check deduplication (claim event)
 * 5. Enqueue for async processing
 * 6. Return 200 OK immediately (< 2 seconds)
 *
 * Async processing (in queue handler):
 * - Route to appropriate handler
 * - Update lastDeliveryAt
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { connectDB, mcpServerRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { Config } from '@server/utils/config';
import { GitHubEvent } from '@server/integrations/github/GitHubEvent';
import { GitHubEventType, WebhookProcessingResult, isValidGitHubEventType } from '@server/integrations/github/types';
import {
  verifyGitHubSignature,
  getRawBody,
  PayloadTooLargeError,
  verifyGitHubPayloadTimestamp,
} from '@server/integrations/github/webhookUtils';
import { sendToQueue } from '@server/utils/sqs';
import { serializeError } from '@server/utils/serializeError';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';

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

    // 1. Extract headers
    const eventType = req.headers['x-github-event'] as string;
    const deliveryId = req.headers['x-github-delivery'] as string;
    const signature = req.headers['x-hub-signature-256'] as string;
    const routingToken = req.headers['x-webhook-token'] as string;

    const auditLogger = IntegrationAuditLogger.create(
      {
        entityType: 'webhook',
        integrationName: 'github',
        action: `webhook_${eventType || 'unknown'}`,
        requestId: deliveryId || randomUUID().split('-')[0],
      },
      req
    );

    logger.debug('[GITHUB-WEBHOOK] Received webhook', {
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
      auditLogger.failure('missing_headers');
      return res.status(400).json({
        success: false,
        message: 'Missing required headers',
        error: 'X-GitHub-Event and X-GitHub-Delivery headers are required',
      });
    }

    if (!routingToken) {
      logger.warn('[GITHUB-WEBHOOK] Missing routing token');
      auditLogger.failure('missing_routing_token');
      return res.status(400).json({
        success: false,
        message: 'Missing routing token',
        error: 'X-Webhook-Token header is required',
      });
    }

    // 2. Get raw body for signature verification
    const rawBody = await getRawBody(req);
    const bodyString = rawBody.toString('utf8');

    // 3. Find MCP server by routing token
    const mcpServer = await mcpServerRepository.findByGitHubWebhookToken(routingToken);

    if (!mcpServer) {
      logger.warn('[GITHUB-WEBHOOK] Unknown routing token', {
        tokenPrefix: routingToken.substring(0, 8) + '...',
      });
      // Return 401 (not 404) to prevent routing token enumeration
      // Attacker shouldn't be able to distinguish "token doesn't exist" from "signature wrong"
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

    // 4. Validate signature (SECURITY-CRITICAL)
    const signatureResult = verifyGitHubSignature(rawBody, signature, webhookConfig.secret);

    if (!signatureResult.valid) {
      // Log detailed error internally but return generic message to prevent enumeration
      logger.warn('[GITHUB-WEBHOOK] Invalid signature', {
        error: signatureResult.error,
        deliveryId,
        mcpServerId: mcpServer.id,
      });
      auditLogger.setUserId(mcpServer.userId);
      auditLogger.failure('invalid_signature', { mcpServerId: mcpServer.id });
      // Return same generic error as unknown token to prevent secondary enumeration
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
        mcpServerId: mcpServer.id,
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
      // Return 200 OK but don't process - GitHub expects 2xx for all valid deliveries
      // This prevents GitHub from retrying unsupported events
      return res.status(200).json({
        success: true,
        message: 'Event type not supported',
        deliveryId,
      });
    }

    // 5. Create GitHubEvent and atomically claim for processing
    const githubEvent = new GitHubEvent(eventType as GitHubEventType, deliveryId, payload);

    // Atomic claim prevents race conditions - only one request can process each event
    const claimResult = await githubEvent.tryClaimForProcessing(logger, 'org');

    if (!claimResult.claimed) {
      logger.info('[GITHUB-WEBHOOK] Event already claimed/processed', {
        deliveryId,
        eventType,
      });
      // Return 200 OK for duplicates (idempotent behavior)
      return res.status(200).json({
        success: true,
        message: 'Event already processed',
        eventType: eventType as GitHubEventType,
        deliveryId,
      });
    }

    // 6. Enqueue for async processing
    const correlationId = randomUUID();

    try {
      await sendToQueue((Resource as any).githubWebhookQueue.url, {
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

      auditLogger.setUserId(mcpServer.userId);
      auditLogger.success({ eventType, mcpServerId: mcpServer.id, correlationId });

      // 7. Return 200 OK immediately (< 2 seconds)
      return res.status(200).json({
        success: true,
        message: 'Event accepted for processing',
        eventType: eventType as GitHubEventType,
        deliveryId,
      });
    } catch (enqueueError) {
      // Enqueue failed - return 500 so GitHub retries
      logger.error('[GITHUB-WEBHOOK] Failed to enqueue event', {
        error: serializeError(enqueueError),
        deliveryId,
        eventType,
      });
      auditLogger.setUserId(mcpServer.userId);
      auditLogger.failure('enqueue_failed');
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

    // Log full error internally but never expose to client
    logger.error('[GITHUB-WEBHOOK] Unexpected error', { error: serializeError(error) });
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: 'An unexpected error occurred',
    });
  }
}
