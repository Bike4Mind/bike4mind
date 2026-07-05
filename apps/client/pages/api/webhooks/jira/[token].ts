import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

/**
 * Jira Webhook Receiver Endpoint
 *
 * Receives Jira webhook events and routes them to Slack channels based on subscriptions.
 *
 * URL format: POST /api/webhooks/jira/{routingToken}
 *
 * Security-critical processing order (sync):
 * 1. Extract routing token from URL
 * 2. Look up webhook config by routing token
 * 3. Validate signature using secret (decrypted)
 * 4. Parse and validate event type
 * 5. Fan out to matching subscriptions
 * 6. Return 200 OK immediately
 *
 * Async processing:
 * - Apply subscription filters (project, priority, issue type)
 * - Format Slack message
 * - POST to Slack webhook URL
 * - Record delivery status
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { Logger } from '@bike4mind/observability';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import {
  // Entity types
  IJiraWebhookSubscriptionDocument,
  JiraWebhookDeliveryStatus,
  // Webhook type guards (accept Record<string, unknown>, validate structure)
  isIssueWebhookEvent,
  isCommentWebhookEvent,
  isSprintWebhookEvent,
  extractWebhookEventType,
  // Slack formatters
  formatIssueEventForSlack,
  formatCommentEventForSlack,
  formatSprintEventForSlack,
  formatGenericEventForSlack,
  SlackMessage,
} from '@bike4mind/common';
import {
  jiraWebhookConfigRepository,
  jiraWebhookSubscriptionRepository,
  jiraWebhookDeliveryRepository,
} from '@bike4mind/database';
import { slackDevWorkspaceRepository } from '@bike4mind/database/infra';
import { User } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { decryptSecret } from '@server/security/secretEncryption';
import { decryptToken } from '@server/security/tokenEncryption';
import { SlackClient } from '@bike4mind/slack';
import {
  verifyJiraSignature,
  getRawBody,
  PayloadTooLargeError,
  validateJiraPayloadTimestamp,
} from '@server/integrations/jira/webhookUtils';
import { WebhookProcessingResult, extractIssueInfo, matchesFilters } from '@server/integrations/jira/types';

/**
 * Sanitize a webhook payload for storage by stripping sensitive/verbose fields.
 * Retains only the structural data needed for debugging failed deliveries.
 */
function sanitizePayloadForStorage(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    webhookEvent: payload.webhookEvent,
    timestamp: payload.timestamp,
  };

  // Issue: keep key/id/type/status/priority, strip description/comments/custom fields
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (issue) {
    const fields = issue.fields as Record<string, unknown> | undefined;
    sanitized.issue = {
      id: issue.id,
      key: issue.key,
      fields: fields
        ? {
            summary: fields.summary,
            project: fields.project,
            issuetype: fields.issuetype,
            priority: fields.priority,
            status: fields.status,
            assignee: fields.assignee
              ? { displayName: (fields.assignee as Record<string, unknown>).displayName }
              : undefined,
          }
        : undefined,
    };
  }

  // User: keep displayName only
  const user = payload.user as Record<string, unknown> | undefined;
  if (user) {
    sanitized.user = { displayName: user.displayName };
  }

  // Changelog: keep field names and from/to strings
  if (payload.changelog) {
    sanitized.changelog = payload.changelog;
  }

  // Sprint: keep id, name, state
  const sprint = payload.sprint as Record<string, unknown> | undefined;
  if (sprint) {
    sanitized.sprint = { id: sprint.id, name: sprint.name, state: sprint.state };
  }

  // Comment: keep id and author displayName only (strip body)
  const comment = payload.comment as Record<string, unknown> | undefined;
  if (comment) {
    const author = comment.author as Record<string, unknown> | undefined;
    sanitized.comment = {
      id: comment.id,
      author: author ? { displayName: author.displayName } : undefined,
    };
  }

  return sanitized;
}

// --- Rate limiting ---

/**
 * In-memory sliding window rate limiter per webhook config.
 * Limits requests per config to prevent abuse/DoS on the webhook endpoint.
 *
 * SECURITY NOTE: The rate limit key is configId (MongoDB ObjectId), which is globally
 * unique. Each organization has exactly one webhook config per Atlassian cloud instance
 * (enforced by unique index on atlassianCloudId). This means rate limiting is inherently
 * isolated per organization - no explicit workspace/org ID needed in the key.
 *
 * Note: This is per-process. For multi-instance deployments, consider
 * upgrading to a shared store (e.g., Redis) if needed.
 */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 120; // Max 120 requests per minute per config

const rateLimitMap = new Map<string, number[]>();

function isRateLimited(configId: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let timestamps = rateLimitMap.get(configId);
  if (!timestamps) {
    timestamps = [];
    rateLimitMap.set(configId, timestamps);
  }

  // Remove expired entries
  const validIndex = timestamps.findIndex(t => t > windowStart);
  if (validIndex > 0) {
    timestamps.splice(0, validIndex);
  } else if (validIndex === -1) {
    timestamps.length = 0;
  }

  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  timestamps.push(now);
  return false;
}

// Periodic cleanup of stale entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [key, timestamps] of rateLimitMap.entries()) {
    const valid = timestamps.filter(t => t > windowStart);
    if (valid.length === 0) {
      rateLimitMap.delete(key);
    } else {
      rateLimitMap.set(key, valid);
    }
  }
}, 300_000).unref(); // .unref() so this doesn't prevent process exit

// Disable body parsing to get raw body for signature verification
export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

/**
 * Get Slack bot token from the first active workspace.
 */
async function getSlackBotToken(): Promise<string | null> {
  const workspaces = await slackDevWorkspaceRepository.findAllActiveWithCredentials();
  if (workspaces.length === 0) return null;

  const workspace = workspaces[0];
  if (workspace.slackBotToken) {
    return decryptToken(workspace.slackBotToken);
  }

  const workspaceWithToken = await slackDevWorkspaceRepository.findByIdWithCredentials(workspace.id);
  return decryptToken(workspaceWithToken?.slackBotToken) ?? null;
}

/**
 * Resolve the Slack channel for a subscription.
 * - 'channel' type: use the specified channel ID directly
 * - 'dm' type: look up the subscription owner's slackUserId for a DM
 */
async function resolveSlackChannel(subscription: IJiraWebhookSubscriptionDocument): Promise<string | null> {
  const { slackTarget } = subscription;

  if (slackTarget.type === 'channel') {
    return slackTarget.channelId;
  }

  // DM fallback: look up user's linked Slack account
  const user = await User.findById(subscription.userId).select('slackSettings.slackUserId').lean();
  return (user as { slackSettings?: { slackUserId?: string } } | null)?.slackSettings?.slackUserId || null;
}

/**
 * Send message to Slack via bot token using chat.postMessage.
 */
async function sendToSlack(
  slackClient: SlackClient,
  channel: string,
  message: SlackMessage
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await slackClient.sendMessage({
      channel,
      text: message.text,
      blocks: message.blocks as any,
    });

    if (result) {
      return { success: true };
    }
    return { success: false, error: 'SlackClient.sendMessage returned null' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error sending to Slack',
    };
  }
}

/**
 * Format webhook event for Slack based on event type.
 * Type guards validate payload structure before narrowing - no unsafe casts needed.
 * Falls back to a generic formatter for unrecognized events or incomplete payloads.
 */
function formatEventForSlack(eventType: string, payload: Record<string, unknown>, siteUrl: string): SlackMessage {
  if (isIssueWebhookEvent(payload)) {
    return formatIssueEventForSlack(payload, siteUrl);
  }

  if (isCommentWebhookEvent(payload)) {
    return formatCommentEventForSlack(payload, siteUrl);
  }

  if (isSprintWebhookEvent(payload)) {
    return formatSprintEventForSlack(payload, siteUrl);
  }

  // Generic fallback for any event we don't have a specialized formatter for
  return formatGenericEventForSlack(eventType, payload, siteUrl);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<WebhookProcessingResult>) {
  const logger = new Logger({ metadata: { context: 'jira-webhook' } });
  const correlationId = randomUUID();

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
      error: 'Only POST requests are accepted',
    });
  }

  try {
    // 1. Extract routing token from URL path
    const routingToken = req.query.token as string;

    if (!routingToken) {
      logger.warn('[JIRA-WEBHOOK] Missing routing token in URL');
      // Audit log for early rejection: no routing token means no webhook config or delivery ID
      IntegrationAuditLogger.create(
        {
          entityType: 'webhook',
          integrationName: 'atlassian',
          action: 'webhook_unknown',
          requestId: randomUUID().split('-')[0],
        },
        req
      ).failure('missing_routing_token');
      return res.status(400).json({
        success: false,
        message: 'Missing routing token',
        error: 'Routing token is required in URL path',
      });
    }

    // 2. Get raw body for signature verification (must be done before any body parsing)
    const rawBody = await getRawBody(req);
    const bodyString = rawBody.toString('utf8');

    // 3. Look up webhook config by routing token
    const jiraWebhookConfig = await jiraWebhookConfigRepository.findByRoutingToken(routingToken);

    if (!jiraWebhookConfig) {
      logger.warn('[JIRA-WEBHOOK] Unknown routing token', {
        tokenPrefix: routingToken.substring(0, 8) + '...',
        correlationId,
      });
      IntegrationAuditLogger.create(
        {
          entityType: 'webhook',
          integrationName: 'atlassian',
          action: 'webhook_unknown',
          requestId: correlationId.split('-')[0],
        },
        req
      ).failure('unknown_routing_token');
      // Return 401 (not 404) to prevent routing token enumeration
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      });
    }

    if (!jiraWebhookConfig.enabled) {
      logger.warn('[JIRA-WEBHOOK] Webhook config is disabled', {
        configId: jiraWebhookConfig.id,
        correlationId,
      });
      return res.status(403).json({
        success: false,
        message: 'Webhook disabled',
        error: 'This webhook configuration is currently disabled',
      });
    }

    // Rate limit per webhook config
    if (isRateLimited(jiraWebhookConfig.id)) {
      logger.warn('[JIRA-WEBHOOK] Rate limited', {
        configId: jiraWebhookConfig.id,
        correlationId,
      });
      IntegrationAuditLogger.create(
        {
          entityType: 'webhook',
          integrationName: 'atlassian',
          action: 'webhook_receive',
          requestId: correlationId.split('-')[0],
          metadata: { configId: jiraWebhookConfig.id },
        },
        req
      ).rateLimited();
      return res.status(429).json({
        success: false,
        message: 'Too many requests',
        error: 'Rate limit exceeded. Try again later.',
      });
    }

    // 4. Extract headers
    const deliveryId = (req.headers['x-atlassian-webhook-identifier'] as string) || randomUUID();
    const signature = req.headers['x-hub-signature'] as string;

    // Create integration audit logger for webhook verification tracking
    const integrationAuditLogger = IntegrationAuditLogger.create(
      {
        entityType: 'webhook',
        integrationName: 'atlassian',
        action: 'webhook_receive', // Event type captured in success metadata
        requestId: deliveryId.split('-')[0],
        metadata: { configId: jiraWebhookConfig.id },
      },
      req
    );

    logger.debug('[JIRA-WEBHOOK] Received webhook', {
      deliveryId,
      hasSignature: !!signature,
      configId: jiraWebhookConfig.id,
      correlationId,
    });

    // 5. Decrypt secret and validate signature
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      logger.error('[JIRA-WEBHOOK] SECRET_ENCRYPTION_KEY not configured');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error',
        error: 'Encryption key not configured',
      });
    }

    let webhookSecret: string;
    try {
      webhookSecret = decryptSecret(jiraWebhookConfig.secret, encryptionKey);
    } catch (decryptError) {
      logger.error('[JIRA-WEBHOOK] Failed to decrypt webhook secret', {
        configId: jiraWebhookConfig.id,
        error: decryptError,
        correlationId,
      });
      return res.status(500).json({
        success: false,
        message: 'Server configuration error',
        error: 'Failed to decrypt webhook secret',
      });
    }

    // Try current secret first
    let signatureResult = verifyJiraSignature(rawBody, signature, webhookSecret);

    // If current secret fails, try previous secret during rotation window
    if (!signatureResult.valid && jiraWebhookConfig.previousSecret && jiraWebhookConfig.previousSecretExpiresAt) {
      const expiresAt = new Date(jiraWebhookConfig.previousSecretExpiresAt);
      if (expiresAt > new Date()) {
        try {
          const previousSecret = decryptSecret(jiraWebhookConfig.previousSecret, encryptionKey);
          const previousResult = verifyJiraSignature(rawBody, signature, previousSecret);
          if (previousResult.valid) {
            signatureResult = previousResult;
            logger.info('[JIRA-WEBHOOK] Signature matched previous secret (rotation in progress)', {
              configId: jiraWebhookConfig.id,
              rotationExpiresAt: jiraWebhookConfig.previousSecretExpiresAt,
              correlationId,
            });
          }
        } catch (decryptError) {
          logger.warn('[JIRA-WEBHOOK] Failed to decrypt previous secret during rotation', {
            configId: jiraWebhookConfig.id,
            error: decryptError,
            correlationId,
          });
        }
      }
    }

    if (!signatureResult.valid) {
      logger.warn('[JIRA-WEBHOOK] Invalid signature', {
        error: signatureResult.error,
        deliveryId,
        configId: jiraWebhookConfig.id,
        correlationId,
      });
      integrationAuditLogger.failure('invalid_signature');
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      });
    }

    // 6. Parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyString);
    } catch {
      logger.error('[JIRA-WEBHOOK] Invalid JSON payload', { deliveryId, correlationId });
      integrationAuditLogger.failure('invalid_json_payload');
      return res.status(400).json({
        success: false,
        message: 'Invalid payload',
        error: 'Request body is not valid JSON',
      });
    }

    // 6.5 Validate payload timestamp (defense-in-depth, after signature verification)
    const timestampValidation = validateJiraPayloadTimestamp(payload.timestamp);
    if (!timestampValidation.valid) {
      logger.warn('[JIRA-WEBHOOK] Payload timestamp validation failed', {
        reason: timestampValidation.reason,
        deliveryId,
        configId: jiraWebhookConfig.id,
        correlationId,
      });
      integrationAuditLogger.failure('stale_timestamp');
      return res.status(401).json({
        success: false,
        message: 'Unauthorized',
        error: 'Invalid credentials',
      });
    } else if (payload.timestamp === undefined || payload.timestamp === null) {
      logger.debug('[JIRA-WEBHOOK] Payload missing timestamp field (replay check skipped)', {
        deliveryId,
        configId: jiraWebhookConfig.id,
        correlationId,
      });
    }

    // Extract and validate event type from payload
    const extractedEventType = extractWebhookEventType(payload);

    if (!extractedEventType) {
      logger.info('[JIRA-WEBHOOK] Missing event type in payload', {
        deliveryId,
        correlationId,
      });
      return res.status(200).json({
        success: true,
        message: 'No event type in payload',
        deliveryId,
      });
    }

    // Assign to const after null check so closures see the narrowed type
    const webhookEventType: string = extractedEventType;

    // 7. Update last delivery timestamp (fire and forget)
    jiraWebhookConfigRepository.updateLastDelivery(jiraWebhookConfig.id).catch(err => {
      logger.error('[JIRA-WEBHOOK] Failed to update lastDeliveryAt', { error: err, correlationId });
    });

    // 8. Find matching subscriptions and fan out
    const subscriptions = await jiraWebhookSubscriptionRepository.findActiveByWebhookConfig(jiraWebhookConfig.id);

    if (subscriptions.length === 0) {
      logger.info('[JIRA-WEBHOOK] No active subscriptions', {
        deliveryId,
        configId: jiraWebhookConfig.id,
        correlationId,
      });
      return res.status(200).json({
        success: true,
        message: 'No active subscriptions',
        eventType: webhookEventType,
        deliveryId,
      });
    }

    const issueInfo = extractIssueInfo(payload);

    const botToken = await getSlackBotToken();

    // Capture config values for use in async closure
    const webhookConfigId = jiraWebhookConfig.id;
    const atlassianSiteUrl = jiraWebhookConfig.atlassianSiteUrl;

    // Process each subscription (fire and forget - don't block response)
    const processSubscriptions = async () => {
      if (!botToken) {
        logger.error('[JIRA-WEBHOOK] No Slack bot token available — cannot deliver notifications', { correlationId });
        return;
      }

      const slackClient = new SlackClient(botToken, logger);

      const results = await Promise.all(
        subscriptions.map(async subscription => {
          const startTime = Date.now();

          try {
            // Check issue filters (only for issue/comment events)
            if (issueInfo) {
              const matches = matchesFilters(issueInfo, {
                projectFilter: subscription.projectFilter,
                priorityFilter: subscription.priorityFilter,
                issueTypeFilter: subscription.issueTypeFilter,
              });

              if (!matches) {
                await recordDelivery(subscription, JiraWebhookDeliveryStatus.Filtered, 'Issue does not match filters');
                return { subscriptionId: subscription.id, status: JiraWebhookDeliveryStatus.Filtered };
              }
            }

            // Resolve Slack channel (channel ID or DM via slackUserId)
            const channel = await resolveSlackChannel(subscription);
            if (!channel) {
              await recordDelivery(
                subscription,
                JiraWebhookDeliveryStatus.Failed,
                'No Slack channel or user ID configured'
              );
              return { subscriptionId: subscription.id, status: JiraWebhookDeliveryStatus.Failed };
            }

            const slackMessage = formatEventForSlack(webhookEventType, payload, atlassianSiteUrl);

            const slackResult = await sendToSlack(slackClient, channel, slackMessage);
            const processingDurationMs = Date.now() - startTime;

            if (slackResult.success) {
              // Reset circuit breaker on success
              await jiraWebhookSubscriptionRepository.resetConsecutiveFailures(subscription.id);
              await recordDelivery(subscription, JiraWebhookDeliveryStatus.Success, undefined, processingDurationMs);
              return { subscriptionId: subscription.id, status: JiraWebhookDeliveryStatus.Success };
            } else {
              // Increment failure counter
              const { wasAutoDisabled } = await jiraWebhookSubscriptionRepository.incrementConsecutiveFailuresAtomic(
                subscription.id,
                10, // threshold
                slackResult.error || 'Unknown error'
              );

              if (wasAutoDisabled) {
                logger.warn('[JIRA-WEBHOOK] Subscription auto-disabled due to failures', {
                  subscriptionId: subscription.id,
                  correlationId,
                });
              }

              await recordDelivery(
                subscription,
                JiraWebhookDeliveryStatus.Failed,
                slackResult.error,
                processingDurationMs,
                sanitizePayloadForStorage(payload)
              );
              return { subscriptionId: subscription.id, status: JiraWebhookDeliveryStatus.Failed };
            }
          } catch (err) {
            logger.error('[JIRA-WEBHOOK] Error processing subscription', {
              subscriptionId: subscription.id,
              error: err,
              correlationId,
            });
            return { subscriptionId: subscription.id, status: JiraWebhookDeliveryStatus.Failed };
          }
        })
      );

      const successful = results.filter(r => r.status === JiraWebhookDeliveryStatus.Success).length;
      const filtered = results.filter(r => r.status === JiraWebhookDeliveryStatus.Filtered).length;
      const failed = results.filter(r => r.status === JiraWebhookDeliveryStatus.Failed).length;

      logger.info('[JIRA-WEBHOOK] Fan-out complete', {
        deliveryId,
        eventType: webhookEventType,
        successful,
        filtered,
        failed,
        correlationId,
      });

      /**
       * Record delivery to audit trail.
       */
      async function recordDelivery(
        subscription: IJiraWebhookSubscriptionDocument,
        status: JiraWebhookDeliveryStatus,
        errorMessage?: string,
        processingDurationMs?: number,
        failedPayload?: Record<string, unknown>
      ) {
        try {
          await jiraWebhookDeliveryRepository.create({
            deliveryId,
            webhookConfigId,
            subscriptionId: subscription.id,
            userId: subscription.userId,
            eventType: webhookEventType,
            projectKey: issueInfo?.projectKey,
            issueKey: issueInfo?.issueKey,
            issueSummary: issueInfo?.summary,
            status,
            processingDurationMs,
            errorMessage,
            correlationId,
            // Only store payload for failed deliveries (for potential replay)
            payload: status === JiraWebhookDeliveryStatus.Failed ? failedPayload : undefined,
          });
        } catch (err) {
          logger.error('[JIRA-WEBHOOK] Failed to record delivery', {
            subscriptionId: subscription.id,
            error: err,
            correlationId,
          });
        }
      }
    };

    // Fire and forget - don't block the response
    processSubscriptions().catch(err => {
      logger.error('[JIRA-WEBHOOK] Fan-out failed', { error: err, correlationId });
    });

    // Audit log: webhook accepted (signature valid, payload parsed, fan-out initiated)
    integrationAuditLogger.success({ eventType: webhookEventType });

    // Return success immediately (async processing continues in background)
    return res.status(200).json({
      success: true,
      message: 'Event accepted for processing',
      eventType: webhookEventType,
      deliveryId,
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logger.warn('[JIRA-WEBHOOK] Payload too large', { error: error.message, correlationId });
      return res.status(413).json({
        success: false,
        message: 'Payload too large',
        error: 'Request body exceeds maximum allowed size',
      });
    }

    logger.error('[JIRA-WEBHOOK] Unexpected error', { error, correlationId });
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: 'An unexpected error occurred',
    });
  }
}
