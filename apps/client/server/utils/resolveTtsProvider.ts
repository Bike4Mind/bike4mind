import { ApiKeyType, VoiceGenerationVendor } from '@bike4mind/common';
import { apiKeyService, voiceService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { apiKeyRepository, adminSettingsRepository, voiceRepository } from '@bike4mind/database';

// Thrown when the selected provider has no usable key (and, for ElevenLabs, no
// voice). Callers map this to a 401 - it's a configuration problem, not a bug.
export class TtsProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsProviderNotConfiguredError';
  }
}

export interface ResolveTtsProviderArgs {
  provider: VoiceGenerationVendor;
  userId: string | undefined;
  requestedVoice?: string;
  // OpenAI only: the user's stored voice preference, used before the admin default.
  preferredVoice?: string | null;
}

export interface ResolvedTtsProvider {
  apiKey: string;
  voice: string | undefined;
}

// Resolves the per-provider API key and effective voice, centralizing the key
// lookup + voice-default logic shared by the unified /api/ai/tts route and the
// legacy per-provider adapters.
export async function resolveTtsProvider({
  provider,
  userId,
  requestedVoice,
  preferredVoice,
}: ResolveTtsProviderArgs): Promise<ResolvedTtsProvider> {
  if (!userId) {
    throw new TtsProviderNotConfiguredError('Authenticated user required');
  }

  if (provider === 'openai') {
    const apiKey = await apiKeyService.getEffectiveApiKey(
      userId,
      { type: ApiKeyType.openai, nullIfMissing: true },
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
    );
    if (!apiKey) {
      throw new TtsProviderNotConfiguredError('OpenAI API key not configured');
    }

    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['voiceSessionAiVoice'] }
    );
    const adminVoice = getSettingsValue('voiceSessionAiVoice', settings) || 'alloy';
    return { apiKey, voice: requestedVoice || preferredVoice || adminVoice };
  }

  // ElevenLabs: prefer a per-user key, else fall back to the admin-provisioned
  // key (via getEffectiveApiKey + the elevenlabs entry in DEMO_KEY_MAP) so the
  // provider works org-wide like every other AI service. Voice is optional: a
  // request voiceId beats the user's active voice, and the service applies a
  // premade default when neither is set.
  const [apiKey, storedVoiceId] = await Promise.all([
    apiKeyService.getEffectiveApiKey(
      userId,
      { type: ApiKeyType.elevenlabs, nullIfMissing: true },
      { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
    ),
    voiceService.getVoiceId(userId, { db: { voices: voiceRepository } }),
  ]);

  if (!apiKey) {
    throw new TtsProviderNotConfiguredError('ElevenLabs API key not configured');
  }
  return { apiKey, voice: requestedVoice || storedVoiceId || undefined };
}
