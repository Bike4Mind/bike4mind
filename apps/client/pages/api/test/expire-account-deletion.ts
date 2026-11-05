import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { User } from '@bike4mind/database';
import { isValidE2eTestSecret } from '@server/auth/e2eTestSecret';
import { completeAccountDeletion } from '@server/users/completeAccountDeletion';
import { Request } from 'express';

interface ExpireAccountDeletionBody {
  email?: unknown;
}

const E2E_EMAIL_PATTERN = /-e2e@test\.com$/i;

/**
 * Ends a test user's deletion grace period now and runs the purge for that user alone: the daily
 * accountDeletionSweep cron only deploys on production and dev, so previews have no other trigger.
 */
const handler = baseApi({ auth: false }).post(
  asyncHandler(async (req: Request<unknown, unknown, ExpireAccountDeletionBody>, res) => {
    // Guard 1: Only allow on local dev and preview deployments
    if (!isE2EEnabled()) {
      return res.status(403).json({ error: 'Test account deletion is only available in development/preview' });
    }

    // Guard 2: E2E secret header
    if (!isValidE2eTestSecret(req.headers['x-e2e-cleanup-secret'])) {
      return res.status(401).json({ error: 'Invalid cleanup secret' });
    }

    // Guard 3: Only test users
    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !E2E_EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Test users must use the -e2e@test.com email pattern' });
    }

    const user = await User.findOne({ email }, '_id deletion')
      .collation({ locale: 'en', strength: 2 })
      .lean<{ _id: unknown; deletion?: unknown }>();
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.deletion) return res.status(409).json({ error: 'This account is not scheduled for deletion' });

    const userId = String(user._id);
    const now = new Date();
    await User.updateOne({ _id: userId, deletion: { $ne: null } }, { $set: { 'deletion.scheduledFor': now } });

    const outcome = await completeAccountDeletion(userId, { logger: req.logger, now });
    return res.status(200).json(outcome);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
