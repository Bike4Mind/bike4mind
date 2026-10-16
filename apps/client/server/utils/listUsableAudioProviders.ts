import {
  supportedSoundGenerationVendor,
  supportedVoiceGenerationVendor,
  type SoundGenerationVendor,
  type VoiceGenerationVendor,
} from '@bike4mind/common';
import { apiKeyService } from '@bike4mind/services';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { AUDIO_VENDOR_API_KEY_TYPE, type AudioVendor } from './audioVendorApiKeyType';

export type UsableAudioProviders = {
  speech: VoiceGenerationVendor[];
  soundEffects: SoundGenerationVendor[];
};

/**
 * The speech and sound-effect providers this user has a key for (their own or the admin's), so Studio can gate
 * its audio tabs the way the music and video tabs gate on their models endpoints. A key the provider would reject
 * still counts: that is only discovered by calling it, and the routes report it then.
 */
export async function listUsableAudioProviders(userId: string): Promise<UsableAudioProviders> {
  const vendors = [
    ...new Set<AudioVendor>([...supportedVoiceGenerationVendor.options, ...supportedSoundGenerationVendor.options]),
  ];
  const keyed = await Promise.all(
    vendors.map(async vendor => {
      const apiKey = await apiKeyService.getEffectiveApiKey(
        userId,
        { type: AUDIO_VENDOR_API_KEY_TYPE[vendor], nullIfMissing: true },
        { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
      );
      return apiKey ? vendor : undefined;
    })
  );
  const usable = new Set(keyed.filter(vendor => vendor !== undefined));

  return {
    speech: supportedVoiceGenerationVendor.options.filter(vendor => usable.has(vendor)),
    soundEffects: supportedSoundGenerationVendor.options.filter(vendor => usable.has(vendor)),
  };
}
