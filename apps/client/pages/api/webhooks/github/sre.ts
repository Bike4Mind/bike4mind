/**
 * System-Level GitHub Webhook for SRE Agent
 *
 * Dedicated endpoint independent of any org's webhook configuration.
 * Validates HMAC signature using the secret stored in SRE config,
 * then dispatches matching events to the merged sreJobQueue, tagged by jobType:
 *   - issues -> jobType: 'analysis' (initial diagnosis)
 *   - pull_request_review -> jobType: 'revision' (revision on change requests)
 *
 * Works with both GitHub App webhooks and manually-configured repo/org webhooks.
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { connectDB, adminSettingsRepository } from '@bike4mind/database';
import { SreAgentConfig, SreAgentConfigSchema, resolveWebhookSecret } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { GitHubEvent } from '@server/integrations/github/GitHubEvent';
import { GitHubEventType } from '@server/integrations/github/types';
import {
  verifyGitHubSignature,
  getRawBody,
  PayloadTooLargeError,
  verifyGitHubPayloadTimestamp,
} from '@server/integrations/github/webhookUtils';
import { WebhookAuditLogger, extractWebhookMetadata } from '@server/integrations/github/WebhookAuditLogger';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';
import { decryptToken } from '@server/security/tokenEncryption';
import {
  dispatchIssueToSre,
  syncSreIssueStateFromWebhook,
  SreIssuePayloadSchema,
} from '@server/integrations/github/sreWebhookDispatch';
import { dispatchReviewToSreRevision } from '@server/integrations/github/sreRevisionDispatch';
import { serializeError } from '@server/utils/serializeError';
import { randomUUID } from 'crypto';

export const config = {
  api: { bodyParser: false, externalResolver: true },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const logger = new Logger({ metadata: { context: 'sre-webhook' } });

  // 1. POST only
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  // 2. Header presence check (cheap pre-auth gate before DB work)
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const eventType = req.headers['x-github-event'] as string | undefined;
  const deliveryId = req.headers['x-github-delivery'] as string | undefined;

  if (!signature || !eventType || !deliveryId) {
    return res.status(400).json({
      success: false,
      message: 'Missing required GitHub webhook headers',
    });
  }

  const integrationAuditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'webhook',
      integrationName: 'github',
      action: `webhook_${eventType}`,
      requestId: deliveryId || randomUUID().split('-')[0],
    },
    req
  );

  try {
    // 3. Get raw body (enforces size limit)
    const rawBody = await getRawBody(req);
    const bodyString = rawBody.toString('utf8');

    // 4. Connect to DB
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

    // 5. Parse JSON first - needed to identify repo for per-repo secret lookup.
    // This is safe: the repo name from the unverified body is only used to SELECT
    // the verification secret. If an attacker forges the repo name, the wrong secret
    // is selected -> HMAC verification fails -> request rejected.
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyString);
    } catch {
      logger.error('[SRE-WEBHOOK] Invalid JSON payload', { deliveryId });
      return res.status(400).json({ success: false, message: 'Invalid payload' });
    }

    // 6. Load SRE config
    const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
    const sreConfig = SreAgentConfigSchema.parse(rawConfig ?? {}) as SreAgentConfig;

    // 7. Resolve per-repo webhook secret (multi-repo HMAC routing)
    const repoSlug = (payload as { repository?: { full_name?: string } }).repository?.full_name || '';
    const webhookSecretEncrypted = resolveWebhookSecret(sreConfig, repoSlug);

    // 8. Fail-closed: webhook secret must be configured
    //    Returns 404 (not 503) to avoid revealing endpoint existence to probes
    if (!webhookSecretEncrypted) {
      logger.warn('[SRE-WEBHOOK] Webhook secret not configured', { repoSlug });
      return res.status(404).json({
        success: false,
        message: 'Not found',
      });
    }

    // 9. Decrypt secret
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      logger.error('[SRE-WEBHOOK] SECRET_ENCRYPTION_KEY not configured');
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    let webhookSecret: string;
    try {
      // Route through decryptToken() for key-rotation fallback: tries the current
      // SECRET_ENCRYPTION_KEY first, then SECRET_ENCRYPTION_KEY_PREVIOUS. This mirrors
      // the org path and prevents a 500 retry storm when the key has been rotated
      // but the SRE secret is still encrypted under the previous key.
      const decrypted = decryptToken(webhookSecretEncrypted);
      if (!decrypted) {
        throw new Error('SRE webhook secret is empty');
      }
      webhookSecret = decrypted;
    } catch (decryptError) {
      logger.error('[SRE-WEBHOOK] Failed to decrypt webhook secret', { error: serializeError(decryptError) });
      return res.status(500).json({ success: false, message: 'Server configuration error' });
    }

    // 10. Verify HMAC signature
    const signatureResult = verifyGitHubSignature(rawBody, signature, webhookSecret);
    if (!signatureResult.valid) {
      logger.warn('[SRE-WEBHOOK] Invalid signature', { deliveryId, repoSlug });
      integrationAuditLogger.failure('invalid_signature');
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // 10. Payload timestamp check (advisory, log-only)
    const timestampCheck = verifyGitHubPayloadTimestamp(payload);
    if (!timestampCheck.fresh) {
      logger.warn('[SRE-WEBHOOK] Stale payload timestamp', {
        source: timestampCheck.timestampSource,
        deliveryId,
      });
    }

    // 11. Handle ping event (required for GitHub webhook setup)
    if (eventType === 'ping') {
      logger.info('[SRE-WEBHOOK] Ping received', { deliveryId });
      integrationAuditLogger.success({ eventType: 'ping' });
      return res.status(200).json({ success: true, message: 'pong' });
    }

    // 12. Filter: only process supported event types
    if (eventType !== 'issues' && eventType !== 'pull_request_review') {
      logger.debug('[SRE-WEBHOOK] Event type not processed', { eventType, deliveryId });
      return res.status(200).json({ success: true, message: 'Accepted' });
    }

    // Extract metadata for audit logging
    const repository = (payload as { repository?: { full_name?: string } }).repository?.full_name || 'unknown';
    const sender = (payload as { sender?: { login?: string } }).sender?.login || 'unknown';

    const auditLogger = WebhookAuditLogger.create({
      deliveryId,
      event: eventType,
      repository,
      sender,
      signatureVerified: true,
      metadata: extractWebhookMetadata(payload),
    });
    auditLogger.received();

    // 13. Atomic deduplication
    const githubEvent = new GitHubEvent(eventType as GitHubEventType, deliveryId, payload);
    const claimResult = await githubEvent.tryClaimForProcessing(logger, 'sre');

    if (!claimResult.claimed) {
      logger.info('[SRE-WEBHOOK] Event already claimed', { deliveryId });
      return res.status(200).json({ success: true, message: 'Accepted' });
    }

    const correlationId = auditLogger.correlationId;

    try {
      if (eventType === 'issues') {
        // 14a. Validate issue payload shape before dispatch
        const parseResult = SreIssuePayloadSchema.safeParse(payload);
        if (!parseResult.success) {
          logger.warn('[SRE-WEBHOOK] Payload does not match expected issue shape', {
            deliveryId,
            errors: parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
          });
          return res.status(200).json({ success: true, message: 'Accepted' });
        }

        // Keep the denormalized githubIssueState fresh for the admin filter.
        // Runs for closed/reopened (dispatchIssueToSre drops `closed` at its
        // eligibility gate, so this is the only path that records a close here).
        // No-ops for other actions; swallows its own errors.
        await syncSreIssueStateFromWebhook(parseResult.data, logger);

        const result = await dispatchIssueToSre(parseResult.data, logger, correlationId);
        logger.info('[SRE-WEBHOOK] Issue dispatch complete', {
          deliveryId,
          dispatched: result.dispatched,
          correlationId,
        });
      } else {
        // 14b. Dispatch pull_request_review to SRE revision pipeline
        //      Zod validation happens inside dispatchReviewToSreRevision
        const result = await dispatchReviewToSreRevision(payload, logger);
        logger.info('[SRE-WEBHOOK] Review dispatch complete', {
          deliveryId,
          dispatched: result.dispatched,
          correlationId,
        });
      }

      integrationAuditLogger.success({ eventType, correlationId });

      // 15. Return generic 200 OK (avoid leaking dispatch details)
      return res.status(200).json({ success: true, message: 'Accepted' });
    } catch (enqueueError) {
      // 16. SQS failure -> 500 so GitHub retries
      logger.error('[SRE-WEBHOOK] Failed to enqueue', { error: serializeError(enqueueError), deliveryId });
      auditLogger.failed(enqueueError instanceof Error ? enqueueError : new Error('Enqueue failed'));
      integrationAuditLogger.failure('enqueue_failed');
      return res.status(500).json({ success: false, message: 'Failed to process event' });
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logger.warn('[SRE-WEBHOOK] Payload too large', { error: (error as Error).message });
      return res.status(413).json({ success: false, message: 'Payload too large' });
    }

    logger.error('[SRE-WEBHOOK] Unexpected error', { error: serializeError(error) });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
