import { baseApi } from '@server/middlewares/baseApi';
import { ttsRequestSchema, VoiceGenerationVendor } from '@bike4mind/common';
import { aiVoiceService } from '@bike4mind/utils';
import { resolveTtsProvider, TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';

const DEFAULT_PROVIDER: VoiceGenerationVendor = 'openai';

/**
 * Unified, multi-provider Text-to-Speech endpoint (#724).
 *
 * Body: { text, provider?, model?, voice?, format?, encoding?, stability?, similarityBoost? }
 * - provider defaults to openai; model/voice/format fall back to per-provider defaults.
 * - encoding 'binary' (default) streams raw audio bytes with an audio/* Content-Type;
 *   'base64' returns JSON { audio, format, contentType }.
 *
 * Mirrors the multi-vendor image API (aiImageService). The legacy
 * /api/ai/text-to-speech and /api/elabs/text-to-speech routes remain as thin
 * adapters over the same aiVoiceService abstraction.
 */
const handler = baseApi().post(async (req, res) => {
  const { text, provider, model, voice, format, encoding, stability, similarityBoost } = ttsRequestSchema.parse(
    req.body
  );

  const vendor = provider ?? DEFAULT_PROVIDER;

  let resolved;
  try {
    resolved = await resolveTtsProvider({
      provider: vendor,
      userId: req.user?.id,
      requestedVoice: voice,
      preferredVoice: req.user?.preferredVoice,
    });
  } catch (error) {
    if (error instanceof TtsProviderNotConfiguredError) {
      return res.status(401).json({ error: error.message });
    }
    throw error;
  }

  const result = await aiVoiceService(vendor, resolved.apiKey, req.logger).synthesize(text, {
    voice: resolved.voice,
    model,
    format,
    stability,
    similarityBoost,
  });

  if (encoding === 'base64') {
    return res.json({
      audio: result.audio.toString('base64'),
      format: result.format,
      contentType: result.contentType,
    });
  }

  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Length', result.audio.length);
  return res.send(result.audio);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
