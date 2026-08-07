import z from 'zod';

// Providers supported by the unified TTS API. Mirrors supportedImageGenerationVendor.
export const supportedVoiceGenerationVendor = z.enum(['openai', 'elevenlabs']);

export type VoiceGenerationVendor = z.infer<typeof supportedVoiceGenerationVendor>;

// Display names for the TTS providers. Shared so the provider picker and any
// message that has to name the vendor that actually produced the audio (e.g. a
// fallback notice) read identically.
export const VOICE_VENDOR_LABELS: Record<VoiceGenerationVendor, string> = {
  openai: 'OpenAI',
  elevenlabs: 'ElevenLabs',
};

// Output container the caller wants back. All providers accept mp3; the rest are
// best-effort per provider (OpenAI supports the full set, ElevenLabs maps a
// subset). The vendor implementation is responsible for the format -> API param
// and format -> Content-Type mapping.
export const voiceOutputFormatSchema = z.enum(['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm']);

export type VoiceOutputFormat = z.infer<typeof voiceOutputFormatSchema>;

// Output formats each provider can actually produce. Validated at the API
// boundary (POST /api/ai/tts) so an unsupported (vendor, format) pair fails
// fast with a clear 422 BEFORE any provider cost is incurred, rather than
// surfacing as an opaque upstream error. OpenAI accepts the full set;
// ElevenLabs maps a subset. MUST stay in sync with each vendor service's format
// map (e.g. ELEVENLABS_OUTPUT_FORMAT in ElevenLabsVoiceService).
export const VOICE_VENDOR_SUPPORTED_FORMATS: Record<VoiceGenerationVendor, VoiceOutputFormat[]> = {
  openai: ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'],
  elevenlabs: ['mp3', 'pcm', 'opus'],
};

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
  // ElevenLabs language_code (ISO 639-1, e.g. "en", "ja"). Pins the output
  // language on models that support it (v2.5+/v3), removing the auto-detection
  // that mispronounces short, isolated tokens (a bare "2", acronyms, names).
  // Best-effort: ignored by providers/models that don't support it.
  languageCode: z.string().optional(),
  // When true, the result is a throwaway audition (e.g. the Settings voice
  // preview) and is never saved to the File Browser, regardless of the user's
  // saveGeneratedAudio preference.
  preview: z.boolean().optional(),
});

export type TTSRequest = z.infer<typeof ttsRequestSchema>;

export type TtsVoiceOption = {
  value: string;
  label: string;
  description: string;
};

// Voices selectable for OpenAI TTS synthesis. Single source of truth reused by
// the Settings voice audition and the in-app audio generator. These are the
// realtime-API voices, a subset shared with the TTS API (both accept them).
// ElevenLabs resolves its voice server-side from the user's stored voiceId, so
// this list is OpenAI-only.
export const AVAILABLE_TTS_VOICES: readonly TtsVoiceOption[] = [
  { value: 'alloy', label: 'Alloy', description: 'Professional and balanced (Female)' },
  { value: 'cedar', label: 'Cedar', description: 'Warm and grounded (Male)' },
  { value: 'echo', label: 'Echo', description: 'Clear and articulate (Male)' },
  { value: 'marin', label: 'Marin', description: 'Natural and expressive (Female)' },
  { value: 'shimmer', label: 'Shimmer', description: 'Energetic and vibrant (Female)' },
] as const;
