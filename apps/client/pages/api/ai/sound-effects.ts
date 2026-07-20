import { ApiKeyType, SoundGenerationVendor, soundEffectsRequestSchema } from '@bike4mind/common';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { aiSoundService } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';

// The stored key type each vendor needs. Resolved per-user first, then falling
// back to the admin-configured key (getEffectiveApiKey), so the feature works
// out of the box on platforms that provide a shared provider key.
const PROVIDER_API_KEY_TYPE: Record<SoundGenerationVendor, ApiKeyType> = {
  elevenlabs: ApiKeyType.elevenlabs,
};

// Provider-agnostic sound-effects generation. Returns raw audio bytes with the
// vendor's content type; the client can play or persist them as it sees fit.
const handler = baseApi().post(async (req, res) => {
  const { provider, text, durationSeconds, promptInfluence, format } = soundEffectsRequestSchema.parse(req.body);

  const apiKey = await apiKeyService.getEffectiveApiKey(
    req.user?.id,
    { type: PROVIDER_API_KEY_TYPE[provider] },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );

  if (!apiKey) {
    return res.status(401).json({ error: `No ${provider} API key configured` });
  }

  try {
    const soundService = aiSoundService(provider, apiKey, req.logger);
    const { audio, contentType } = await soundService.generate(text, { durationSeconds, promptInfluence, format });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', audio.length);
    return res.send(audio);
  } catch (error) {
    req.logger.error('Sound-effects generation failed', {
      provider,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return res.status(502).json({ error: 'Sound generation failed' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
