import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import * as z from 'zod';
import { aiVoiceService } from '@bike4mind/utils';
import { resolveTtsProvider, TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';
import { estimateTtsCreditCost, TTS_DEFAULT_MODEL } from '@bike4mind/common';
import { deliverGeneratedAudio } from '@server/utils/generatedAudioDelivery';
import { deductTtsCredits } from '@server/utils/deductTtsCredits';
import { assertPreflightCredits, InsufficientCreditsPreflightError } from '@server/utils/creditPreflight';

// Legacy ElevenLabs TTS adapter, scheduled for deprecation (CONVENTIONS.md section 7).
// Thin wrapper over the unified aiVoiceService: body { message } -> { audio: base64 }
// (inline responses are a superset of that). Shares response delivery with
// POST /api/ai/tts: oversized audio returns a `delivery: 'url'` body, not a 413.
// New integrations should use /api/ai/tts with provider 'elevenlabs'.
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const { message } = z.object({ message: z.string() }).parse(req.body);

    let resolved;
    try {
      resolved = await resolveTtsProvider({ provider: 'elevenlabs', userId: req.user?.id });
    } catch (error) {
      if (error instanceof TtsProviderNotConfiguredError) {
        return res.status(401).json({ error: error.message });
      }
      throw error;
    }

    const userId = req.user?.id;
    if (userId) {
      try {
        await assertPreflightCredits({
          userId,
          estimatedCredits: estimateTtsCreditCost('elevenlabs', TTS_DEFAULT_MODEL.elevenlabs, message.length),
          featureLabel: 'text-to-speech',
        });
      } catch (error) {
        if (error instanceof InsufficientCreditsPreflightError) {
          return res.status(402).json({ error: error.message });
        }
        throw error;
      }
    }

    try {
      const { audio, model, characters } = await aiVoiceService('elevenlabs', resolved.apiKey, req.logger).synthesize(
        message,
        {
          voice: resolved.voice,
          stability: 0,
          similarityBoost: 0,
        }
      );
      if (userId) {
        await deductTtsCredits({ userId, vendor: 'elevenlabs', model, characters, logger: req.logger });
      }
      return await deliverGeneratedAudio(res, {
        audio,
        contentType: 'audio/mpeg',
        encoding: 'base64',
        save: undefined,
        logger: req.logger,
      });
    } catch (error) {
      // This route now bills credits; log the failure so a synthesis error is
      // observable rather than a silent 500 (mirrors the sibling TTS routes).
      req.logger.error('ElevenLabs TTS error', { error });
      return res.status(500).json({ error: 'Something went wrong' });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
