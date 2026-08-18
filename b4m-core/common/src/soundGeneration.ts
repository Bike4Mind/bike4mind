import z from 'zod';

/**
 * Supported sound-effects generation vendors. Currently only ElevenLabs.
 * New vendors are added here and in the `aiSoundService` factory.
 */
export const supportedSoundGenerationVendor = z.enum(['elevenlabs']);

export type SoundGenerationVendor = z.infer<typeof supportedSoundGenerationVendor>;

// Max prompt length (characters) for a sound-effects generation, per the
// ElevenLabs sound-generation API. Exported so the client can enforce the same
// limit before calling the endpoint.
export const SOUND_EFFECTS_MAX_INPUT_CHARS = 1000;

/**
 * Inbound request body for `POST /api/ai/sound-effects`.
 *
 * `durationSeconds` and `promptInfluence` bounds mirror the ElevenLabs
 * sound-generation limits (0.5-30s for the default eleven_text_to_sound_v2
 * model, prompt influence 0-1). `format` is the provider-specific output
 * encoding token (e.g. `mp3_44100_128`).
 */
export const soundEffectsRequestSchema = z.object({
  provider: supportedSoundGenerationVendor.default('elevenlabs'),
  text: z.string().min(1).max(SOUND_EFFECTS_MAX_INPUT_CHARS),
  durationSeconds: z.number().min(0.5).max(30).optional(),
  promptInfluence: z.number().min(0).max(1).optional(),
  format: z.string().optional(),
});

export type SoundEffectsRequest = z.infer<typeof soundEffectsRequestSchema>;
