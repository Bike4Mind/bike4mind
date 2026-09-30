/**
 * Push webhook for the data-lake GitHub App (infra/secrets.ts GITHUB_LAKE_APP_*).
 *
 * A push to a connected repository's default branch queues the same re-sync as the manual button
 * (pages/api/data-lakes/[id]/github-connection/sync.ts), as a non-manual run: githubLakeIngest
 * no-ops when HEAD already matches the last synced commit (so a redelivery is harmless) and
 * defers behind a sync that is already in flight (so a push mid-sync is not lost).
 * There is no user here; the App's webhook HMAC is the only auth.
 */

import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Resource } from 'sst';
import { connectDB, orgGitHubLakeConnectionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { getRawBody, PayloadTooLargeError, verifyGitHubSignature } from '@server/integrations/github/webhookUtils';
import { sendToQueue } from '@server/utils/sqs';

const UNSET_SECRET = 'not-configured';

const PushEventSchema = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  repository: z.object({ id: z.number(), default_branch: z.string() }),
  installation: z.object({ id: z.number() }),
});

type PushEvent = z.infer<typeof PushEventSchema>;

const isDefaultBranchPush = (event: PushEvent): boolean =>
  !event.deleted && event.ref === `refs/heads/${event.repository.default_branch}`;

export const config = {
  api: { bodyParser: false, externalResolver: true },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const logger = new Logger({ metadata: { context: 'github-lake-push-webhook' } });

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const secret = Config.GITHUB_LAKE_APP_WEBHOOK_SECRET;
  if (!secret || secret === UNSET_SECRET) {
    logger.warn('[githubLakePush] GITHUB_LAKE_APP_WEBHOOK_SECRET is not configured; refusing delivery');
    return res.status(503).json({ message: 'Webhook not configured' });
  }

  let rawBody: Buffer;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return res.status(413).json({ message: 'Payload too large' });
    }
    logger.warn('[githubLakePush] could not read the body', { error });
    return res.status(400).json({ message: 'Could not read the body' });
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const verification = verifyGitHubSignature(rawBody, signature, secret);
  if (!verification.valid) {
    logger.warn('[githubLakePush] rejected delivery', { error: verification.error });
    return res.status(401).json({ message: 'Invalid signature' });
  }

  const eventType = req.headers['x-github-event'];
  if (eventType !== 'push') {
    // The App also delivers ping and installation events; only pushes move a lake.
    return res.status(200).json({ status: 'ignored', reason: 'not a push event' });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Body is not JSON' });
  }
  const parsed = PushEventSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Not a GitHub App push payload' });
  }
  const event = parsed.data;
  if (!isDefaultBranchPush(event)) {
    return res.status(200).json({ status: 'ignored', reason: 'not the default branch' });
  }

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
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
    logger.error('[githubLakePush] re-sync enqueue failed', { connectionId: conn.id, error });
    // Best-effort, as in the manual sync route: a record failure must not mask the enqueue one.
    await orgGitHubLakeConnectionRepository
      .recordLastError(conn.id, 'A push could not queue a re-sync. Re-sync manually.')
      .catch(e =>
        logger.warn('[githubLakePush] could not record the enqueue failure', { connectionId: conn.id, error: e })
      );
    return res.status(500).json({ message: 'Could not queue the re-sync' });
  }

  logger.info('[githubLakePush] re-sync queued', {
    connectionId: conn.id,
    deliveryId: req.headers['x-github-delivery'],
  });
  return res.status(202).json({ status: 'queued', connectionId: conn.id });
}
