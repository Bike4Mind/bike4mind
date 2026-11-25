import { connectDB, adminSettingsRepository } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { postMessageToSlack } from '@bike4mind/utils';
import { getSettingsMap } from '@bike4mind/utils';
import { resolveSlackWebhookUrl } from '@bike4mind/server-utils/integrations/slack/slack';
import { Config } from '@bike4mind/server-utils/utils/config';
import { SECRET_ROTATION_GRACE_MS } from '@bike4mind/server-utils/auth/secretRotationGrace';
import { isAccessReviewReminderDay } from '@bike4mind/server-utils/security/accessReview/accessReview';
import { sendAccessReviewReminder } from '@bike4mind/server-utils/security/accessReview/accessReviewData';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';

// Contained so a failed reminder is logged once rather than retried into a repost.
async function remindAccessReview(now: Date, slackWebhookUrl: string): Promise<string | undefined> {
  try {
    return await sendAccessReviewReminder(now, async text => {
      const posted = await postMessageToSlack(slackWebhookUrl, text);
      if (!posted) throw new Error('Access review reminder was not accepted by Slack');
    });
  } catch (error) {
    Logger.error('Access review reminder failed', { error });
    return undefined;
  }
}

/**
 * Daily housekeeping: retires an expired JWT previous key (read by the token grace window in
 * jwtSecretOrKeyProvider.ts, verifyWsAccessToken.ts and auth/refreshToken.ts) and posts the
 * quarterly access review reminder (docs/security/quarterly-access-review.md).
 */
export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  try {
    // Kept out of the token read paths so verifying a token never writes.
    await secretRotationRepository.expirePreviousKey('JWT_SECRET', SECRET_ROTATION_GRACE_MS);

    const now = new Date();
    const accessReviewDue = Resource.App.stage === 'production' && isAccessReviewReminderDay(now);
    if (!accessReviewDue) return { status: 'OK' };

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const slackWebhookUrl = resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', settings);
    if (!slackWebhookUrl) {
      Logger.info('Slack webhook not configured - skipping access review reminder');
      return { status: 'OK', skipped: true, reason: 'Slack webhook not configured' };
    }

    const accessReviewQuarter = await remindAccessReview(now, slackWebhookUrl);
    return { status: 'OK', ...(accessReviewQuarter && { accessReviewQuarter }) };
  } catch (error) {
    Logger.error('Error in secret rotation notifier', { error });
    throw error;
  }
}
