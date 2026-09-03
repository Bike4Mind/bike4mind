import z from 'zod';
import type { ApiErrorCode } from './apiErrorCodes';
// The specific file, not the `./schemas` barrel - the barrel drags in an unbuilt
// dist in the CI openapi job (same note as tts.contract.ts).
import { ApiErrorSchema } from './schemas/chat';

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

// ElevenLabs documents language_code as ISO 639-1, so anything that is not two
// lowercase letters ("english", "en-US") is rejected at the request boundary
// instead of costing a provider round-trip. Deliberately a shape check rather
// than the full 639-1 registry: it catches every realistic caller mistake
// without a list that would reject a code a provider later starts accepting.
// If a provider ever needs a longer tag (e.g. a 639-2 code), widen this.
export const TTS_LANGUAGE_CODE_PATTERN = /^[a-z]{2}$/;

export const ttsLanguageCodeSchema = z
  .string()
  .regex(TTS_LANGUAGE_CODE_PATTERN, 'languageCode must be a lowercase ISO 639-1 code, e.g. "en" or "ja"');

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
  languageCode: ttsLanguageCodeSchema.optional(),
  // When true, the result is a throwaway audition (e.g. the Settings voice
  // preview) and is never saved to the File Browser, regardless of the user's
  // saveGeneratedAudio preference.
  preview: z.boolean().optional(),
});

export type TTSRequest = z.infer<typeof ttsRequestSchema>;

/**
 * Why a browsable copy of generated audio was not kept. Saving is best-effort and
 * never fatal (the caller was already billed for the bytes it is being handed), so
 * this is reported alongside a successful response rather than as an error.
 *
 * Must stay in sync with `PersistGeneratedAudioResult` in
 * apps/client/server/utils/persistGeneratedAudio.ts, which derives its `reason`
 * from this schema.
 */
export const audioSaveSkippedReasonSchema = z.enum(['storage_limit', 'file_too_large', 'error']);

export type AudioSaveSkippedReason = z.infer<typeof audioSaveSkippedReasonSchema>;

/**
 * JSON body of `POST /api/ai/tts` when the caller asks for `encoding: 'base64'`.
 * The default `binary` encoding returns raw audio bytes instead and has no JSON
 * shape.
 *
 * The save + provider fields are all optional because the handler spreads them in
 * only when they apply: the save fields are absent when no copy was attempted
 * (`preview: true`, or the saveGeneratedAudio preference is off), and
 * `provider`/`fallbackFrom` appear only when the requested provider was
 * unavailable and another one stood in.
 */
export const ttsBase64ResponseSchema = z.object({
  /** Base64-encoded audio payload. */
  audio: z.string(),
  format: voiceOutputFormatSchema,
  contentType: z.string(),
  saved: z.boolean().optional(),
  fabFileId: z.string().optional(),
  fileUrl: z.string().optional(),
  saveSkippedReason: audioSaveSkippedReasonSchema.optional(),
  /** The provider that actually produced the audio, present only on a fallback. */
  provider: supportedVoiceGenerationVendor.optional(),
  /** The originally requested provider that could not serve the request. */
  fallbackFrom: supportedVoiceGenerationVendor.optional(),
});

export type TtsBase64Response = z.infer<typeof ttsBase64ResponseSchema>;

/**
 * The classifiers `POST /api/ai/tts` can emit - a narrowing of the platform-wide
 * `API_ERROR_CODES`, not a parallel vocabulary (CONVENTIONS.md section 1). The
 * `satisfies` fails the build if a code here is not in the shared union.
 *
 * `insufficient_credits` rides the 422 and means the same thing it does on
 * /api/ai/music and every other credit-metered endpoint. The two provider codes
 * are easy to invert: `provider_not_configured` means WE have no usable key,
 * `provider_rejected` means the provider REFUSED the key we sent.
 */
export const TTS_ERROR_CODES = [
  'insufficient_credits',
  'provider_not_configured',
  'provider_rejected',
] as const satisfies readonly ApiErrorCode[];

/**
 * Error body for `POST /api/ai/tts`, shared by every error status the route
 * declares. `errorCode` is present only on the conditions that carry a
 * classifier; an ordinary validation 422 has none.
 */
export const ttsErrorResponseSchema = ApiErrorSchema.extend({
  provider: supportedVoiceGenerationVendor.optional(),
  errorCode: z.enum(TTS_ERROR_CODES).optional(),
});

/**
 * 413 body: the audio was generated and billed but exceeds the serverless
 * response-size cap. When a browsable copy was saved, `fileUrl` is how the caller
 * retrieves the audio it paid for.
 *
 * Not derived from `ApiErrorSchema`, unlike `ttsErrorResponseSchema`: this body is
 * written directly (pages/api/ai/tts.ts, the exceedsTtsResponseLimit guard) rather
 * than thrown, so errorHandler never sees it and never adds `name` here.
 */
export const ttsResponseTooLargeSchema = z.object({
  error: z.string(),
  provider: supportedVoiceGenerationVendor,
  saved: z.literal(true).optional(),
  fabFileId: z.string().optional(),
  fileUrl: z.string().optional(),
});

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
