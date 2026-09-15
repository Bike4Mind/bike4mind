import { baseApi } from '@server/middlewares/baseApi';
import * as z from 'zod';
import { apiKeyService } from '@bike4mind/services';
import { ApiKeyType } from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';

// Test real-time voice by creating a temporary session
const handler = baseApi().post(async (req, res) => {
  console.log('[DEBUG] Test Realtime Voice API - Request received');

  const validatedBody = z
    .object({
      text: z.string().min(1).max(500), // Limit for testing
      voice: z.string().optional(),
    })
    .parse(req.body);

  const { text, voice } = validatedBody;
  console.log('[DEBUG] Test Realtime Voice - Text:', text.substring(0, 50) + '...', 'Voice:', voice);

  // Get voice settings from admin settings
  const settings = await getSettingsMap(
    {
      adminSettings: adminSettingsRepository,
    },
    {
      names: ['voiceSessionAiVoice'],
    }
  );

  // Get OpenAI API key
  const openaiApiKey = await apiKeyService.getEffectiveApiKey(
    req.user?.id,
    { type: ApiKeyType.openai, nullIfMissing: true },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );

  if (!openaiApiKey) {
    console.log('[ERROR] Test Realtime Voice - No OpenAI API key found');
    return res.status(401).json({ error: 'OpenAI API key not configured' });
  }

  // Use provided voice or fall back to user preference or admin setting
  const adminVoice = getSettingsValue('voiceSessionAiVoice', settings) || 'alloy';
  const selectedVoice = voice || req.user?.preferredVoice || adminVoice;

  console.log('[DEBUG] Test Realtime Voice - Selected voice:', selectedVoice);

  try {
    // For now, fallback to TTS API since real-time API requires WebRTC
    // In future, we could implement a WebSocket connection to get real-time voice
    // but that's significantly more complex for just testing voices

    // Note: The real-time API voices (alloy, echo, shimmer, etc.) are available
    // in both TTS and real-time APIs, though they may sound slightly different
    const OpenAI = (await import('openai')).default;
    const openai = new OpenAI({ apiKey: openaiApiKey });

    const response = await openai.audio.speech.create({
      model: 'tts-1-hd', // Use HD model for better quality matching real-time
      voice: selectedVoice as any,
      input: text,
      response_format: 'mp3',
      speed: 1.0, // Normal speed to match real-time API
    });

    // Convert response to buffer
    const buffer = Buffer.from(await response.arrayBuffer());

    // Set appropriate headers for audio response
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Voice-Model', 'tts-1-hd'); // Indicate this is TTS, not real real-time
    res.setHeader('X-Voice-Selected', selectedVoice);

    return res.send(buffer);
  } catch (error: any) {
    console.error('Test Realtime Voice error:', error);

    if (error.status === 400) {
      return res.status(400).json({ error: 'Invalid request parameters' });
    } else if (error.status === 401) {
      return res.status(401).json({ error: 'Invalid OpenAI API key' });
    } else if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
    } else {
      return res.status(500).json({ error: 'Failed to generate test voice' });
    }
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
