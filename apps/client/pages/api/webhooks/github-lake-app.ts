/**
 * Webhook of the read-only data-lake GitHub App (infra/secrets.ts GITHUB_LAKE_APP_*). Not under
 * webhooks/github/, which holds the token-routed MCP-server and org webhooks this App shares nothing with.
 *
 * Revokes connections when the App loses access: `installation.deleted` (every binding of the
 * installation) and `installation_repositories.removed` (bindings of the removed repositories).
 * It only enqueues: GitHub never redelivers on its own and a live sync makes the purge 409, so
 * githubLakeRevokeQueue owns the retries. Everything else, including the reversible `suspend`, is
 * acknowledged and ignored.
 *
 * Unlike webhooks/github.ts there is no delivery dedup (a revoke is idempotent, so a redelivery is a
 * no-op) and no IntegrationAuditLogger record (that log is per user integration; this App has none).
 */
import { isPlaceholderValue } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
import { resolveGitHubLakeRevocation } from '@server/integrations/github/dataLake/githubLakeRevocation';
import { getRawBody, PayloadTooLargeError, verifyGitHubSignature } from '@server/integrations/github/webhookUtils';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';

const handler = baseApi({ auth: false }).post(async (req, res) => {
  const secret = Config.GITHUB_LAKE_APP_WEBHOOK_SECRET;
  // Fail closed: without the secret no delivery can be authenticated.
  if (!secret || isPlaceholderValue(secret)) {
    req.logger.warn('GitHub lake app webhook received but GITHUB_LAKE_APP_WEBHOOK_SECRET is not configured');
    return res.status(503).json({ error: 'GitHub data-lake App webhook is not configured on this deployment' });
  }

  let rawBody: Buffer;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    if (!(error instanceof PayloadTooLargeError)) throw error;
    req.logger.warn('GitHub lake app webhook payload too large', { error: error.message });
    return res.status(413).json({ error: 'Request body exceeds maximum allowed size' });
  }
  const signatureResult = verifyGitHubSignature(
    rawBody,
    req.headers['x-hub-signature-256'] as string | undefined,
    secret
  );
  if (!signatureResult.valid) {
    req.logger.warn('GitHub lake app webhook signature verification failed', { error: signatureResult.error });
    return res.status(401).json({ error: signatureResult.error ?? 'Invalid signature' });
  }

  const eventType = req.headers['x-github-event'] as string | undefined;
  const deliveryId = req.headers['x-github-delivery'] as string | undefined;
  req.logger.updateMetadata({ event: eventType, deliveryId });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    req.logger.warn('GitHub lake app webhook payload is not valid JSON', { error });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const resolved = await resolveGitHubLakeRevocation(eventType, payload);
  if (resolved === null) {
    req.logger.info('GitHub lake app webhook: ignoring event', { event: eventType, deliveryId });
    return res.status(200).json({ ignored: true });
  }
  if ('malformed' in resolved) {
    req.logger.warn('GitHub lake app webhook: malformed payload for a handled event', {
      event: eventType,
      deliveryId,
      error: resolved.malformed,
    });
    return res.status(400).json({ error: 'Malformed payload' });
  }

  const { installationId, connectionIds } = resolved;
  // A failed enqueue 500s so the delivery shows failed for a manual redeliver; revokes are idempotent.
  await Promise.all(
    connectionIds.map(connectionId => sendToQueue(Resource.githubLakeRevokeQueue.url, { connectionId, installationId }))
  );

  req.logger.info('GitHub lake app webhook: queued revoke for the affected connections', {
    event: eventType,
    deliveryId,
    installationId,
    count: connectionIds.length,
  });

  return res.status(202).json({ queued: connectionIds.length });
});

export const config = {
  api: {
    bodyParser: false, // raw body needed for signature verification
    externalResolver: true,
  },
};

export default handler;
