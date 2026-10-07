import { baseApi } from '@server/middlewares/baseApi';
import * as z from 'zod';
import { aiVoiceService } from '@bike4mind/utils';
import { resolveTtsProvider, TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';
import {
  assertTtsCreditsAvailable,
  deductTtsCredits,
  InsufficientTtsCreditsError,
} from '@server/utils/deductTtsCredits';

// Legacy OpenAI TTS adapter, scheduled for deprecation (CONVENTIONS.md section 7).
// Thin wrapper over the unified aiVoiceService: body { text, voice? } -> raw
// audio/mpeg bytes. Shares response delivery (size ceiling, oversized -> 303 to a
// signed URL) with POST /api/ai/tts. New integrations should use /api/ai/tts.
const handler = baseApi().post(async (req, res) => {
  const { text, voice } = z
    .object({
      text: z.string().min(1).max(4096), // OpenAI TTS limit
      voice: z.string().optional(),
    })
    .parse(req.body);

  let resolved;
  try {
    resolved = await resolveTtsProvider({
      provider: 'openai',
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

  const userId = req.user?.id;
  if (userId) {
    try {
      await assertTtsCreditsAvailable(userId);
    } catch (error) {
      if (error instanceof InsufficientTtsCreditsError) {
        return res.status(402).json({ error: error.message });
      }
      throw error;
    }
  }

  try {
    const { audio, model, characters } = await aiVoiceService('openai', resolved.apiKey, req.logger).synthesize(text, {
      voice: resolved.voice,
      model: 'tts-1', // standard model for faster response
      format: 'mp3',
    });

    if (userId) {
      await deductTtsCredits({ userId, vendor: 'openai', model, characters, logger: req.logger });
    }

    // Delivery overrides this with no-store for oversized audio (a short-lived URL or a 413).
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
    return await deliverGeneratedAudio(res, {
      audio,
      contentType: 'audio/mpeg',
      encoding: 'binary',
      save: undefined,
      logger: req.logger,
    });
  } catch (error: unknown) {
    req.logger.error('OpenAI TTS error:', { error });
    const status = (error as { status?: number })?.status;
    if (status === 400) {
      return res.status(400).json({ error: 'Invalid request parameters' });
    } else if (status === 401) {
      return res.status(401).json({ error: 'Invalid OpenAI API key' });
    } else if (status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
    }
    return res.status(500).json({ error: 'Failed to generate speech' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
