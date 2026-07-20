import { ApiKeyType, SoundGenerationVendor, soundEffectsRequestSchema } from '@bike4mind/common';
import { apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { aiSoundService } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';

// Per-provider stored key each vendor needs. ElevenLabs is not covered by
// getEffectiveApiKey/getEffectiveLLMApiKeys, so we resolve the per-user key
// directly (same as /api/elabs/text-to-speech).
const PROVIDER_API_KEY_TYPE: Record<SoundGenerationVendor, ApiKeyType> = {
  elevenlabs: ApiKeyType.elevenlabs,
};

// Provider-agnostic sound-effects generation. Returns raw audio bytes with the
// vendor's content type; the client can play or persist them as it sees fit.
const handler = baseApi().post(async (req, res) => {
  const { provider, text, durationSeconds, promptInfluence, format } = soundEffectsRequestSchema.parse(req.body);

  const apiKey = await apiKeyService
    .getApiKey(req.user?.id, { type: PROVIDER_API_KEY_TYPE[provider] }, { db: { apiKeys: apiKeyRepository } })
    .then(key => key?.apiKey ?? null);

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
