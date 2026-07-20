import z from 'zod';

// Providers supported by the unified TTS API. Mirrors supportedImageGenerationVendor.
export const supportedVoiceGenerationVendor = z.enum(['openai', 'elevenlabs']);

export type VoiceGenerationVendor = z.infer<typeof supportedVoiceGenerationVendor>;

// Output container the caller wants back. All providers accept mp3; the rest are
// best-effort per provider (OpenAI supports the full set, ElevenLabs maps a
// subset). The vendor implementation is responsible for the format -> API param
// and format -> Content-Type mapping.
export const voiceOutputFormatSchema = z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']);

export type VoiceOutputFormat = z.infer<typeof voiceOutputFormatSchema>;

// How the endpoint should return the audio. 'binary' streams raw bytes with an
// audio/* Content-Type; 'base64' returns JSON { audio, format, contentType }.
export const voiceResponseEncodingSchema = z.enum(['binary', 'base64']);

export type VoiceResponseEncoding = z.infer<typeof voiceResponseEncodingSchema>;

// Per-provider max input length (characters). OpenAI hard-caps at 4096;
// ElevenLabs accepts more (model-dependent, up to 10k on multilingual v2). Each
// vendor service enforces its own limit so no provider is needlessly throttled
// to another's ceiling.
export const TTS_MAX_INPUT_CHARS: Record<VoiceGenerationVendor, number> = {
  openai: 4096,
  elevenlabs: 10000,
};

// Absolute ceiling for the shared request schema: the largest any provider
// accepts. The exact per-provider limit is enforced downstream in each service.
export const TTS_ABSOLUTE_MAX_INPUT_CHARS = Math.max(...Object.values(TTS_MAX_INPUT_CHARS));

export const ttsRequestSchema = z.object({
  text: z.string().min(1).max(TTS_ABSOLUTE_MAX_INPUT_CHARS),
  provider: supportedVoiceGenerationVendor.optional(),
  model: z.string().optional(),
  voice: z.string().optional(),
  format: voiceOutputFormatSchema.optional(),
  encoding: voiceResponseEncodingSchema.optional(),
  // ElevenLabs voice_settings; ignored by providers that don't use them.
  stability: z.number().min(0).max(1).optional(),
  similarityBoost: z.number().min(0).max(1).optional(),
});

export type TTSRequest = z.infer<typeof ttsRequestSchema>;
