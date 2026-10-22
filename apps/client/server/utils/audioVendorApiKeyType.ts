import { ApiKeyType, type SoundGenerationVendor, type VoiceGenerationVendor } from '@bike4mind/common';

export type AudioVendor = VoiceGenerationVendor | SoundGenerationVendor;

/**
 * The stored key type each audio vendor needs. getEffectiveApiKey resolves the user's own key first and
 * then the admin-provisioned one. Shared so the TTS resolver, the sound-effects route and the provider
 * list cannot drift apart.
 */
export const AUDIO_VENDOR_API_KEY_TYPE: Record<AudioVendor, ApiKeyType> = {
  openai: ApiKeyType.openai,
  elevenlabs: ApiKeyType.elevenlabs,
};
