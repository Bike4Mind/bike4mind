import z from 'zod';

/**
 * Supported background-music generation vendors. Currently only ElevenLabs.
 * New vendors are added here and in the `aiMusicService` factory.
 */
export const supportedMusicGenerationVendor = z.enum(['elevenlabs']);

export type MusicGenerationVendor = z.infer<typeof supportedMusicGenerationVendor>;

/**
 * Supported ElevenLabs music models. Scoped to `music_v1` for now; `music_v2` is
 * a deliberate follow-up (see the parent issue). Adding it here is the only
 * change the request surface needs to accept it.
 */
export const supportedMusicModel = z.enum(['music_v1']);

export type MusicModel = z.infer<typeof supportedMusicModel>;

export const DEFAULT_MUSIC_MODEL_ID: MusicModel = 'music_v1';

/**
 * Default clip length (ms) billed and generated when the caller omits `lengthMs`.
 * Deliberately conservative: the route forwards this exact value to the provider
 * so the generated length always equals the billed length (deterministic
 * reserve/settle), and a small default keeps a prompt-only call cheap. Callers
 * that want a longer track pass `lengthMs` explicitly.
 */
export const DEFAULT_MUSIC_LENGTH_MS = 10_000;

/** ElevenLabs music length bounds, in milliseconds (`music_length_ms`). */
export const MIN_MUSIC_LENGTH_MS = 3_000;
export const MAX_MUSIC_LENGTH_MS = 600_000;

/**
 * Inbound request body for `POST /api/ai/music`.
 *
 * `lengthMs` bounds mirror the ElevenLabs Music API (`music_length_ms`,
 * 3s-600s). It carries a default rather than being optional so the billed
 * length is always known up front (the reserve/settle path needs a deterministic
 * cost before generation) and the route can force that exact length on the
 * provider. `format` is the provider-specific output encoding token (e.g.
 * `mp3_44100_128`).
 */
export const musicRequestSchema = z.object({
  provider: supportedMusicGenerationVendor.default('elevenlabs'),
  prompt: z.string().min(1).max(2000),
  lengthMs: z.number().int().min(MIN_MUSIC_LENGTH_MS).max(MAX_MUSIC_LENGTH_MS).default(DEFAULT_MUSIC_LENGTH_MS),
  forceInstrumental: z.boolean().optional(),
  modelId: supportedMusicModel.default(DEFAULT_MUSIC_MODEL_ID),
  format: z.string().optional(),
});

export type MusicRequest = z.infer<typeof musicRequestSchema>;
