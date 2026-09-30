/**
 * The single webhook of the data-lake GitHub App (infra/secrets.ts GITHUB_LAKE_APP_*). A GitHub App
 * has exactly one webhook URL, so every event it delivers lands here and is dispatched by type:
 *
 * - `push`: a push to a connected repository's default branch queues the same re-sync as the manual
 *   button (pages/api/data-lakes/[id]/github-connection/sync.ts), as a non-manual run: githubLakeIngest
 *   no-ops when HEAD already matches the last synced commit (so a redelivery is harmless), and defers
 *   behind a sync that is already in flight for up to ~18 min (its MAX_GITHUB_LAKE_REDRIVES redrives
 *   at REDRIVE_DELAY_SECONDS apart) before dropping the message. A sync that runs longer than that
 *   silently misses this push; the next push, or a manual Sync, picks up the missed commit.
 * - `installation.deleted` / `installation_repositories.removed`: the App lost access, so each
 *   affected connection is queued on githubLakeRevokeQueue for purge (queueHandlers/githubLakeRevoke.ts).
 *   It only enqueues: GitHub never redelivers on its own and a live sync makes the purge 409, so the
 *   queue owns the retries. A revoke is idempotent, so a redelivery is a no-op.
 * - Everything else (ping, the reversible `suspend`, other actions) is acknowledged and ignored.
 *
 * There is no user here; the App's webhook HMAC is the only auth.
 *
 * Response bodies here are a bare {message}/{status}, not the {success,message} WebhookProcessingResult
 * envelope the general GitHub webhook routes use (github.ts, sre.ts): this route mirrors the shape of
 * the manual-trigger route it is a webhook analog of (github-connection/sync.ts) instead.
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Resource } from 'sst';
import { isPlaceholderValue } from '@bike4mind/common';
import { connectDB, orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { getRawBody, PayloadTooLargeError, verifyGitHubSignature } from '@server/integrations/github/webhookUtils';
import {
  findRevokedConnectionIds,
  isGitHubLakeRevocationEvent,
  parseGitHubLakeRevocation,
} from '@server/integrations/github/dataLake/githubLakeRevocation';
import { sendToQueue } from '@server/utils/sqs';
import { IntegrationAuditLogger } from '@server/integrations/integrationAuditLogger';

const PushEventSchema = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  repository: z.object({ id: z.number(), default_branch: z.string() }),
  installation: z.object({ id: z.number() }),
});

type PushEvent = z.infer<typeof PushEventSchema>;

type AuditLogger = ReturnType<typeof IntegrationAuditLogger.create>;

type DeliveryContext = {
  res: NextApiResponse;
  logger: Logger;
  auditLogger: AuditLogger;
  deliveryId: string | undefined;
};

const isDefaultBranchPush = (event: PushEvent): boolean =>
  !event.deleted && event.ref === `refs/heads/${event.repository.default_branch}`;

const connectToDatabase = (logger: Logger) => connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);

export const config = {
  api: { bodyParser: false, externalResolver: true },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const logger = new Logger({ metadata: { context: 'github-lake-webhook' } });
  const deliveryId = req.headers['x-github-delivery'] as string | undefined;
  const eventType = req.headers['x-github-event'] as string | undefined;

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const auditLogger = IntegrationAuditLogger.create(
    {
      entityType: 'webhook',
      integrationName: 'github',
      // Unverified until the HMAC check below; it only labels the audit record.
      action: isGitHubLakeRevocationEvent(eventType) ? 'webhook_lake_revoke' : 'webhook_lake_push',
      requestId: deliveryId || randomUUID(),
    },
    req
  );

  const secret = Config.GITHUB_LAKE_APP_WEBHOOK_SECRET;
  // Every reserved placeholder (the shipped 'not-configured', SST's default) fails closed: signed with
  // a publicly known key, this unauthenticated route would let anyone enqueue purges.
  if (!secret || isPlaceholderValue(secret)) {
    logger.warn('[githubLakeWebhook] GITHUB_LAKE_APP_WEBHOOK_SECRET is not configured; refusing delivery', {
      deliveryId,
    });
    auditLogger.failure('not_configured');
    return res.status(503).json({ message: 'Webhook not configured' });
  }

  let rawBody: Buffer;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      auditLogger.failure('payload_too_large');
      return res.status(413).json({ message: 'Payload too large' });
    }
    logger.warn('[githubLakeWebhook] could not read the body', { deliveryId, error });
    auditLogger.failure('body_read_failed');
    return res.status(400).json({ message: 'Could not read the body' });
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const verification = verifyGitHubSignature(rawBody, signature, secret);
  if (!verification.valid) {
    logger.warn('[githubLakeWebhook] rejected delivery', { deliveryId, error: verification.error });
    auditLogger.failure('invalid_signature');
    return res.status(401).json({ message: 'Invalid signature' });
  }

  if (!eventType) {
    logger.warn('[githubLakeWebhook] missing x-github-event header', { deliveryId });
    auditLogger.failure('missing_event_header');
    return res.status(400).json({ message: 'Missing x-github-event header' });
  }
  if (eventType !== 'push' && !isGitHubLakeRevocationEvent(eventType)) {
    return res.status(200).json({ status: 'ignored', reason: 'not a handled event' });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    auditLogger.failure('invalid_json');
    return res.status(400).json({ message: 'Body is not JSON' });
  }

  const context: DeliveryContext = { res, logger, auditLogger, deliveryId };
  if (eventType === 'push') {
    return handlePush(body, context);
  }
  return handleRevocation(eventType, body, context);
}

async function handlePush(body: unknown, { res, logger, auditLogger, deliveryId }: DeliveryContext) {
  const parsed = PushEventSchema.safeParse(body);
  if (!parsed.success) {
    auditLogger.failure('invalid_payload_shape');
    return res.status(400).json({ message: 'Not a GitHub App push payload' });
  }
  const event = parsed.data;
  if (!isDefaultBranchPush(event)) {
    return res.status(200).json({ status: 'ignored', reason: 'not the default branch' });
  }

  await connectToDatabase(logger);
  // repositoryId alone is unique; matching the installation too keeps a push delivered for one
  // installation from resyncing a repo bound through another.
  const connections = await orgGitHubLakeConnectionRepository.findByInstallationId(event.installation.id);
  const conn = connections.find(c => c.repositoryId === event.repository.id);
  if (!conn || conn.enabled === false) {
    return res.status(200).json({ status: 'ignored', reason: 'no enabled lake for this repository' });
  }

  try {
    await sendToQueue(Resource.githubLakeIngestQueue.url, { connectionId: conn.id, manual: false });
  } catch (error) {
    logger.error('[githubLakeWebhook] re-sync enqueue failed', { deliveryId, connectionId: conn.id, error });
    auditLogger.failure('enqueue_failed', { connectionId: conn.id });
    // Best-effort, as in the manual sync route: a record failure must not mask the enqueue one.
    await orgGitHubLakeConnectionRepository
      .recordLastError(conn.id, 'A push could not queue a re-sync. Re-sync manually.')
      .catch(e =>
        logger.warn('[githubLakeWebhook] could not record the enqueue failure', {
          deliveryId,
          connectionId: conn.id,
          error: e,
        })
      );
    return res.status(500).json({ message: 'Could not queue the re-sync' });
  }

  logger.info('[githubLakeWebhook] re-sync queued', { connectionId: conn.id, deliveryId });
  auditLogger.success({ connectionId: conn.id });
  return res.status(202).json({ status: 'queued', connectionId: conn.id });
}

async function handleRevocation(
  eventType: string,
  body: unknown,
  { res, logger, auditLogger, deliveryId }: DeliveryContext
) {
  const target = parseGitHubLakeRevocation(eventType, body);
  if (target === null) {
    return res.status(200).json({ status: 'ignored', reason: 'not a revoking action' });
  }
  if ('malformed' in target) {
    logger.warn('[githubLakeWebhook] malformed payload for a revoking event', {
      event: eventType,
      deliveryId,
      error: target.malformed,
    });
    auditLogger.failure('invalid_payload_shape');
    return res.status(400).json({ message: 'Malformed payload' });
  }

  await connectToDatabase(logger);
  const { installationId } = target;
  const connectionIds = await findRevokedConnectionIds(target);
  try {
    await Promise.all(
      connectionIds.map(connectionId =>
        sendToQueue(Resource.githubLakeRevokeQueue.url, { connectionId, installationId })
      )
    );
  } catch (error) {
    // 500 so the delivery shows failed for a manual redeliver; revokes are idempotent.
    logger.error('[githubLakeWebhook] revoke enqueue failed', { deliveryId, installationId, error });
    auditLogger.failure('enqueue_failed', { installationId });
    return res.status(500).json({ message: 'Could not queue the revoke' });
  }

  logger.info('[githubLakeWebhook] revoke queued for the affected connections', {
    event: eventType,
    deliveryId,
    installationId,
    count: connectionIds.length,
  });
  auditLogger.success({ installationId, count: connectionIds.length });
  return res.status(202).json({ status: 'queued', count: connectionIds.length });
}
