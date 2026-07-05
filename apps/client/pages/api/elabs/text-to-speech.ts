import { ApiKeyType } from '@bike4mind/common';
import { apiKeyRepository, voiceRepository } from '@bike4mind/database';
import { apiKeyService, voiceService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import axios from 'axios';
import * as z from 'zod';

const BASE_URL = 'https://api.elevenlabs.io/v1/text-to-speech/';

// This api converts text to speech using eleven labs
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const validatedBody = z.object({ message: z.string() }).parse(req.body);
    const userId = req.user?.id;

    let apiKey: string | null = null;
    let voiceId: string | null = null;
    try {
      [apiKey, voiceId] = await Promise.all([
        apiKeyService
          .getApiKey(userId, { type: ApiKeyType.elevenlabs }, { db: { apiKeys: apiKeyRepository } })
          .then(key => key?.apiKey ?? null),
        voiceService.getVoiceId(userId, { db: { voices: voiceRepository } }),
      ]);
    } catch (e) {
      return res.status(401).json({ error: 'API key or voice id not configured' });
    }

    if (!apiKey || !voiceId) return res.status(401).json({ error: 'API key or voice id not configured' });

    const headers = {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    };

    const { message } = validatedBody;
    const voiceSettings = {
      stability: 0,
      similarity_boost: 0,
    };
    try {
      const response = await axios.post(
        `${BASE_URL}${voiceId}`,
        { text: message, voice_settings: voiceSettings },
        { headers, responseType: 'arraybuffer' }
      );

      if (response.status === 200) {
        const base64Audio = Buffer.from(response.data, 'binary').toString('base64');
        return res.send({ audio: base64Audio });
      } else {
        if (response.status === 401)
          return res.status(401).json({ error: 'Qouta Exceeded, Check your Eleven Labs plan' });
      }
    } catch {
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
