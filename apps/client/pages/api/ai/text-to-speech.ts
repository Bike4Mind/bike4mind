import { baseApi } from '@server/middlewares/baseApi';
import OpenAI from 'openai';
import * as z from 'zod';
import { apiKeyService } from '@bike4mind/services';
import { ApiKeyType } from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';

// OpenAI Text-to-Speech API endpoint
const handler = baseApi().post(async (req, res) => {
  console.log('[DEBUG] TTS API - Request received');
  console.log('[DEBUG] TTS API - Method:', req.method);
  console.log('[DEBUG] TTS API - Body:', req.body);

  const validatedBody = z
    .object({
      text: z.string().min(1).max(4096), // OpenAI TTS limit
      voice: z.string().optional(),
    })
    .parse(req.body);

  const { text, voice } = validatedBody;
  console.log('[DEBUG] TTS API - Validated body:', { text: text.substring(0, 50) + '...', voice });

  // Get voice settings from admin settings
  const settings = await getSettingsMap(
    {
      adminSettings: adminSettingsRepository,
    },
    {
      names: ['voiceSessionAiVoice'],
    }
  );

  // Debug logging
  console.log('[DEBUG] TTS API - User ID:', req.user?.id);
  console.log('[DEBUG] TTS API - User object:', req.user ? 'exists' : 'missing');

  // Get OpenAI API key using the same method as voice sessions
  const openaiApiKey = await apiKeyService.getEffectiveApiKey(
    req.user?.id,
    { type: ApiKeyType.openai, nullIfMissing: true },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );

  console.log('[DEBUG] TTS API - OpenAI key exists:', !!openaiApiKey);
  console.log('[DEBUG] TTS API - OpenAI key length:', openaiApiKey ? openaiApiKey.length : 'N/A');

  if (!openaiApiKey) {
    console.log('[ERROR] TTS API - No OpenAI API key found');
    return res.status(401).json({ error: 'OpenAI API key not configured' });
  }

  // Use provided voice or fall back to user preference or admin setting
  const adminVoice = getSettingsValue('voiceSessionAiVoice', settings) || 'alloy';
  const selectedVoice = voice || req.user?.preferredVoice || adminVoice;

  try {
    const openai = new OpenAI({ apiKey: openaiApiKey });

    const response = await openai.audio.speech.create({
      model: 'tts-1', // Use the standard model for faster response
      voice: selectedVoice as any, // OpenAI voice names
      input: text,
      response_format: 'mp3',
    });

    // Convert response to buffer
    const buffer = Buffer.from(await response.arrayBuffer());

    // Set appropriate headers for audio response
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

    return res.send(buffer);
  } catch (error: any) {
    console.error('OpenAI TTS error:', error);

    // Handle specific OpenAI errors
    if (error.status === 400) {
      return res.status(400).json({ error: 'Invalid request parameters' });
    } else if (error.status === 401) {
      return res.status(401).json({ error: 'Invalid OpenAI API key' });
    } else if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
    } else {
      return res.status(500).json({ error: 'Failed to generate speech' });
    }
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
