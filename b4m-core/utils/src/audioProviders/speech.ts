import { TTS_DEFAULT_MODEL, type VoiceGenerationVendor, type VoiceOutputFormat } from '@bike4mind/common';
import type {
  ProviderContext,
  ProviderOutput,
  ProviderTerminalResult,
  SyncGenerationProvider,
} from '../generationProviders/types';
import { aiVoiceService } from '../voiceGeneration';
import { decodeInlineOutput, toAudioProviderResult } from './errors';

export type SpeechProviderRequest = {
  text: string;
  voice?: string;
  model?: string;
  format?: VoiceOutputFormat;
  stability?: number;
  similarityBoost?: number;
  languageCode?: string;
};

export type SpeechProvider = SyncGenerationProvider<VoiceGenerationVendor, string, SpeechProviderRequest>;

// The models voicePricing prices per vendor; voicePricing keeps its rate tables private, so keep in sync.
const SPEECH_MODELS: Record<VoiceGenerationVendor, readonly string[]> = {
  openai: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts'],
  elevenlabs: [
    'eleven_multilingual_v2',
    'eleven_multilingual_v1',
    'eleven_monolingual_v1',
    'eleven_turbo_v2_5',
    'eleven_turbo_v2',
    'eleven_flash_v2_5',
    'eleven_flash_v2',
  ],
};

export const createSpeechProvider = (vendor: VoiceGenerationVendor): SpeechProvider => ({
  mode: 'sync',
  id: vendor,
  models: [...new Set([TTS_DEFAULT_MODEL[vendor], ...SPEECH_MODELS[vendor]])],

  async generate(request: SpeechProviderRequest, _inputs, ctx: ProviderContext): Promise<ProviderTerminalResult> {
    try {
      const result = await aiVoiceService(vendor, ctx.apiKey, ctx.logger).synthesize(request.text, {
        voice: request.voice,
        model: request.model,
        format: request.format,
        stability: request.stability,
        similarityBoost: request.similarityBoost,
        language: request.languageCode,
        signal: ctx.signal,
      });
      return {
        status: 'succeeded',
        output: { kind: 'inline', base64: result.audio.toString('base64'), contentType: result.contentType },
      };
    } catch (error) {
      return toAudioProviderResult(error, `${vendor}_speech`);
    }
  },

  async fetchOutput(output: ProviderOutput): Promise<Buffer> {
    return decodeInlineOutput(output);
  },
});
