/**
 * Emails the owner of each MCP key (explicitScopeOnly) that expires within 7 days, once per key.
 * Schedule: daily (infra/cron.ts apiKeyExpiryReminder). The claim is a conditional write, so an
 * overlapping or repeated run never double-sends; the renewal link matches the expired-key 401.
 */
import { connectDB, userApiKeyRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { userApiKeyService } from '@bike4mind/services';
import { apiKeyRenewalUrl } from '@bike4mind/server-utils/auth/expiredApiKeyRefusal';
import { Config } from '@bike4mind/server-utils/utils/config';
import { queuedMailer } from '@bike4mind/server-utils/utils/mailer/queuedMailer';
import { Resource } from 'sst';

export const API_KEY_EXPIRY_REMINDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const logger = new Logger({ metadata: { service: 'apiKeyExpiryReminder' } });

export async function runApiKeyExpiryReminder(now: Date = new Date()) {
  const until = new Date(now.getTime() + API_KEY_EXPIRY_REMINDER_WINDOW_MS);
  const keys = await userApiKeyRepository.findExpiringExplicitScopeOnly(now, until);
  const renewUrl = apiKeyRenewalUrl();
  let reminded = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      if (!(await userApiKeyRepository.claimExpiryReminder(key.id))) continue;
      await userApiKeyService.notifyApiKeyExpiring(
        { holderUserId: key.userId, keyName: key.name, expiresAt: key.expiresAt!, renewUrl },
        { db: { users: userRepository }, mailer: queuedMailer, logger }
      );
      reminded++;
    } catch (error) {
      failed++;
      logger.warn('[apiKeyExpiryReminder] key skipped', { keyId: key.id, error: String(error) });
    }
  }
  logger.info('[apiKeyExpiryReminder] done', { found: keys.length, reminded, failed });
  return { found: keys.length, reminded, failed };
}

export const handler = async () => {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runApiKeyExpiryReminder();
};
