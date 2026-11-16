import { VoiceGenerationVendor } from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { AUDIO_VENDOR_API_KEY_TYPE } from './audioVendorApiKeyType';

/** The key synthesis would use for this provider (the user's own, else the admin one), or null. */
export async function getTtsProviderKey(provider: VoiceGenerationVendor, userId: string) {
  return apiKeyService.getEffectiveApiKey(
    userId,
    { type: AUDIO_VENDOR_API_KEY_TYPE[provider], nullIfMissing: true },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );
}
