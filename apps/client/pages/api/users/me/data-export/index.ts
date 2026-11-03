import { v4 as uuidv4 } from 'uuid';
import { ForbiddenError } from '@bike4mind/common';
import { cacheRepository } from '@bike4mind/database';
import { TooManyRequestsError } from '@bike4mind/utils';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { stepUpGate } from '@server/auth/stepUp';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { logAuthAudit } from '@server/utils/authAudit';

const EXPORT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Starts a self-service export of the caller's account data. The worker
 * (apps/workers/src/queueHandlers/accountDataExport.ts) builds the zip and emails a link to
 * GET ./[jobId]. jwtOnly + step-up: an API key or a stale session must not be able to pull everything.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(stepUpGate())
  .post(async (req, res) => {
    if (req.user.impersonatedBy) {
      throw new ForbiddenError("Cannot export an account's data while impersonating its user.");
    }

    // Counted here rather than by the rateLimit middleware so a failed enqueue can give the slot back.
    const rateKey = `rate-limit:${req.user.id}:account-data-export`;
    const quota = await cacheRepository.tryIncrementWithinLimitFixedWindow(rateKey, 1, EXPORT_WINDOW_MS);
    if (!quota.success) {
      const timeLeftMs = Math.max(0, quota.expiresAt.getTime() - Date.now());
      const retryAfterSeconds = Math.max(1, Math.ceil((timeLeftMs > 0 ? timeLeftMs : EXPORT_WINDOW_MS) / 1000));
      res.setHeader('Retry-After', retryAfterSeconds);
      throw new TooManyRequestsError(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`);
    }

    const exportJobId = uuidv4();
    try {
      await sendToQueue(getSourceQueueUrl('accountDataExportQueue'), { exportJobId, userId: req.user.id });
    } catch (error) {
      req.logger.error('[Account Data Export] Failed to queue job', { exportJobId, error });
      try {
        await cacheRepository.decrementCounter(rateKey);
      } catch (rollbackError) {
        req.logger.error('[Account Data Export] Failed to release the rate limit slot', { rollbackError });
      }
      return res.status(500).json({ error: 'Failed to start the export. Please try again later.' });
    }

    await logAuthAudit(req, {
      userId: req.user.id,
      event: 'account_data_export_requested',
      actorUserId: req.user.id,
      metadata: { exportJobId },
    });

    return res.status(202).json({ exportJobId });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
