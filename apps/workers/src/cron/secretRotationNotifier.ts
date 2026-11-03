import { connectDB, adminSettingsRepository } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { postMessageToSlack } from '@bike4mind/utils';
import { getSettingsMap } from '@bike4mind/utils';
import { resolveSlackWebhookUrl } from '@bike4mind/server-utils/integrations/slack/slack';
import { Config } from '@bike4mind/server-utils/utils/config';
import { getSecretRotationConfig } from '@bike4mind/server-utils/lib/secretRotation/constants';
import { SECRET_ROTATION_GRACE_MS } from '@bike4mind/server-utils/auth/secretRotationGrace';
import { Resource } from 'sst';

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));

  try {
    // Retire rotated-out secrets whose grace window has closed. Kept out of the read paths so
    // verifying a token never writes.
    await secretRotationRepository.expirePreviousKey('JWT_SECRET', SECRET_ROTATION_GRACE_MS);
    const now = new Date();
    const warningThreshold = 7; // days before expiration to warn

    // Get all active secrets, filtered to only those present in the current config.
    // This makes the cron self-healing: removing an entry from the rotation config
    // immediately stops alerts for it even if the DB record still has isActive: true.
    const configKeys = new Set(Object.keys(getSecretRotationConfig()));
    const allActiveSecrets = await secretRotationRepository.find({ isActive: true });
    const secrets = allActiveSecrets.filter(s => configKeys.has(s.keyName));

    const dueSecrets = secrets.filter(secret => {
      const daysUntilExpiration = Math.floor((secret.nextRotation.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return daysUntilExpiration <= warningThreshold;
    });

    if (dueSecrets.length === 0) {
      console.log('No secrets due for rotation');
      return { status: 'OK', message: 'No secrets due for rotation' };
    }

    const message = [
      `:warning: *${dueSecrets.length} secret(s) due for rotation*`,
      '---',
      ...dueSecrets.map(secret =>
        [
          `*${secret.keyName}*`,
          `_Next rotation due:_ ${secret.nextRotation.toISOString().split('T')[0]}`,
          `_Rotation interval:_ ${secret.rotationIntervalDays} days`,
          `_Description:_ ${secret.description || 'None'}`,
        ].join('\n')
      ),
    ].join('\n\n');

    // Secret-rotation reminders are operational notifications -> LiveOps channel.
    // Load admin settings via the shared cached settings map (the handler already
    // established the DB connection above); the resolver reads the keys it needs from it.
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const slackWebhookUrl = resolveSlackWebhookUrl('SlackLiveopsWebhookUrl', settings);

    // resolveSlackWebhookUrl already normalizes unset/placeholder/whitespace values to '',
    // so a falsy result is the only "not configured" signal we need to check.
    if (!slackWebhookUrl) {
      console.log('Slack webhook not configured - skipping notification');
      return { status: 'OK', notified: 0, skipped: true, reason: 'Slack webhook not configured' };
    }

    await postMessageToSlack(slackWebhookUrl, message);

    return { status: 'OK', notified: dueSecrets.length };
  } catch (error) {
    console.error('Error in secret rotation notifier:', error);
    throw error;
  }
}
