import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import * as z from 'zod';
import { aiVoiceService } from '@bike4mind/utils';
import { resolveTtsProvider, TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';
import { exceedsTtsResponseLimit, TTS_RESPONSE_TOO_LARGE_MESSAGE } from '@server/utils/ttsResponseLimit';
import {
  assertTtsCreditsAvailable,
  deductTtsCredits,
  InsufficientTtsCreditsError,
} from '@server/utils/deductTtsCredits';

// Legacy ElevenLabs TTS adapter. Kept as a thin, contract-stable wrapper over
// the unified aiVoiceService (#724): body { message } -> { audio: base64 }.
// New integrations should use POST /api/ai/tts with provider 'elevenlabs'.
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
        await assertTtsCreditsAvailable(userId);
      } catch (error) {
        if (error instanceof InsufficientTtsCreditsError) {
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
      if (exceedsTtsResponseLimit(audio.length)) {
        return res.status(413).json({ error: TTS_RESPONSE_TOO_LARGE_MESSAGE });
      }
      return res.send({ audio: audio.toString('base64') });
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
