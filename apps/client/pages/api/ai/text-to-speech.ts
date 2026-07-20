import { baseApi } from '@server/middlewares/baseApi';
import * as z from 'zod';
import { aiVoiceService } from '@bike4mind/utils';
import { resolveTtsProvider, TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';

// Legacy OpenAI TTS adapter. Kept as a thin, contract-stable wrapper over the
// unified aiVoiceService (#724): body { text, voice? } -> raw audio/mpeg bytes.
// New integrations should use POST /api/ai/tts.
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

  try {
    const { audio } = await aiVoiceService('openai', resolved.apiKey, req.logger).synthesize(text, {
      voice: resolved.voice,
      model: 'tts-1', // standard model for faster response
      format: 'mp3',
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audio.length);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour
    return res.send(audio);
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
