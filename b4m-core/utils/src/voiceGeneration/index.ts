import { VoiceGenerationVendor } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { AIVoiceService } from './AIVoiceService';
import { OpenAIVoiceService } from './OpenAIVoiceService';
import { ElevenLabsVoiceService } from './ElevenLabsVoiceService';

export { AIVoiceService, OpenAIVoiceService, ElevenLabsVoiceService };
export { CONTENT_TYPE_BY_FORMAT } from './AIVoiceService';
export type { VoiceSynthesisOptions, VoiceSynthesisResult } from './AIVoiceService';

/**
 * Factory for the appropriate TTS provider, analogous to aiImageService.
 */
export function aiVoiceService(vendor: VoiceGenerationVendor, apiKey: string, logger: Logger): AIVoiceService {
  switch (vendor) {
    case 'openai':
      return new OpenAIVoiceService(apiKey, logger);
    case 'elevenlabs':
      return new ElevenLabsVoiceService(apiKey, logger);
    default:
      throw new Error(`Unknown AI voice vendor: ${vendor}`);
  }
}
