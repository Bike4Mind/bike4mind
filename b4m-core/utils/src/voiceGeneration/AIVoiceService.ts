import { Logger } from '@bike4mind/observability';
import { VoiceOutputFormat } from '@bike4mind/common';

export interface VoiceSynthesisOptions {
  // Provider voice id/name. OpenAI: 'alloy' etc.; ElevenLabs: a voiceId.
  voice?: string;
  // Provider model id. OpenAI: 'tts-1'; ElevenLabs: 'eleven_monolingual_v1'.
  model?: string;
  format?: VoiceOutputFormat;
  // ElevenLabs voice_settings; other providers ignore these.
  stability?: number;
  similarityBoost?: number;
}

export interface VoiceSynthesisResult {
  audio: Buffer;
  // e.g. 'audio/mpeg' - the HTTP Content-Type for the returned bytes.
  contentType: string;
  format: VoiceOutputFormat;
}

// Content-Type for each supported output format, shared by all vendor
// implementations so the wire contract stays consistent across providers.
export const CONTENT_TYPE_BY_FORMAT: Record<VoiceOutputFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/pcm',
};

export abstract class AIVoiceService {
  constructor(
    protected apiKey: string,
    protected logger: Logger
  ) {}

  abstract synthesize(text: string, options?: VoiceSynthesisOptions): Promise<VoiceSynthesisResult>;
}
