import { apiKeyService } from '@bike4mind/auth';
import { ApiKeyType, type UsageKeySource } from '@bike4mind/common';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { component: 'generationJobs' } });

/**
 * The `keySource` stamp for an ElevenLabs usage row, so the admin plan view can leave calls on a user's own key out of
 * the platform quota. Other providers get no stamp.
 *
 * Job handlers resolve the key at submit and their usage recorders receive only the job, so this re-resolves it at
 * record time. The answer differs only if the user adds or removes their own key while the job runs.
 */
export const usageKeySourceFields = async (
  provider: string,
  userId: string
): Promise<{ keySource?: UsageKeySource }> => {
  if (provider !== 'elevenlabs') return {};
  try {
    const resolved = await apiKeyService.getEffectiveApiKeyWithSource(
      userId,
      { type: ApiKeyType.elevenlabs, nullIfMissing: true },
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
    );
    return resolved ? { keySource: resolved.source } : {};
  } catch (error) {
    // A usage row without the stamp is still worth writing.
    logger.warn('failed to resolve usage key source', { provider, userId, error });
    return {};
  }
};
