import { z } from 'zod';
import type { ApiErrorCode } from '../apiErrorCodes';
import { GENERATION_OUTPUT_AVAILABILITIES } from '../generation/types';
import { supportedSoundGenerationVendor } from '../soundGeneration';
import {
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  type GenerationJobErrorCode,
} from '../types/entities/GenerationJobTypes';
import { supportedVoiceGenerationVendor } from '../voiceGeneration';

// The speech and sound-effect job resources /api/ai/tts and /api/ai/sound-effects answer with (202) when a clip
// outlasts the request. Mirrors musicGenerations.ts; snake_case per CONVENTIONS.md.

// The classifiers an audio job can carry. Internal-only codes are folded in by toPublicAudioJobErrorCode.
export const AUDIO_JOB_PUBLIC_ERROR_CODES = [
  'content_blocked',
  'provider_timeout',
  'provider_error',
  'output_too_large',
  'cancelled',
] as const satisfies readonly ApiErrorCode[];
export type AudioJobPublicErrorCode = (typeof AUDIO_JOB_PUBLIC_ERROR_CODES)[number];

export function toPublicAudioJobErrorCode(code: GenerationJobErrorCode): AudioJobPublicErrorCode {
  switch (code) {
    case 'orphaned_submit':
    case 'enqueue_failed':
    // Neither audio kind takes an input image or is region-gated.
    case 'input_image_not_found':
    case 'region_unavailable':
      return 'provider_error';
    case 'content_blocked':
    case 'provider_timeout':
    case 'provider_error':
    case 'output_too_large':
    case 'cancelled':
      return code;
    // Refused before submit, so the provider never ran and the hold is returned, as for a cancel.
    case 'account_blocked':
      return 'cancelled';
    default: {
      const unreachable: never = code;
      throw new Error(`Unmapped generation job error code: ${String(unreachable)}`);
    }
  }
}

const audioJobOutputSchema = z.object({
  availability: z
    .enum(GENERATION_OUTPUT_AVAILABILITIES)
    .describe(
      '`ready`: url is set. `pending_scan`: the saved file is still being scanned. `unavailable`: the file was ' +
        'blocked by the scan or deleted and url will never be set.'
    ),
  url: z
    .string()
    .nullable()
    .describe('Signed download URL, valid until expires_at. Set only when availability is `ready`, otherwise null.'),
  expires_at: z.string().nullable().describe('ISO 8601. When url stops working; null whenever url is.'),
  content_type: z.string(),
  duration_seconds: z.number().nullable().describe('The length of the clip, or null when it could not be measured.'),
  file_id: z.string().nullable().describe('The Files entry, or null when the clip was stored outside Files.'),
});

const audioJobTrailingFields = {
  source: z.enum(GENERATION_JOB_SOURCES),
  error: z.object({ code: z.enum(AUDIO_JOB_PUBLIC_ERROR_CODES), message: z.string() }).nullable(),
  output: audioJobOutputSchema.nullable(),
  credits: z.object({ reserved: z.number().nullable(), settled: z.number().nullable() }),
  created_at: z.string(),
  updated_at: z.string(),
};

// Key order is part of the published bytes: must stay in sync with SPEECH_GENERATION_PROJECTION
// (apps/client/server/generations/toPublicGenerationJob.ts).
export const SpeechGenerationSchema = z.object({
  id: z.string(),
  object: z.literal('speech_generation'),
  state: z.enum(GENERATION_JOB_STATES),
  text: z.string(),
  provider: supportedVoiceGenerationVendor.describe('The provider asked for, with the default applied.'),
  model: z.string().nullable().describe('The model you sent, or null for the provider default.'),
  voice: z.string().nullable().describe('The voice you sent, or null for the default.'),
  ...audioJobTrailingFields,
});
export type SpeechGeneration = z.infer<typeof SpeechGenerationSchema>;

// As SpeechGenerationSchema: in sync with SOUND_EFFECT_GENERATION_PROJECTION, key order included.
export const SoundEffectGenerationSchema = z.object({
  id: z.string(),
  object: z.literal('sound_effect_generation'),
  state: z.enum(GENERATION_JOB_STATES),
  text: z.string(),
  provider: supportedSoundGenerationVendor,
  duration_seconds: z.number().nullable().describe('The length requested, or null to let the provider choose.'),
  ...audioJobTrailingFields,
});
export type SoundEffectGeneration = z.infer<typeof SoundEffectGenerationSchema>;
