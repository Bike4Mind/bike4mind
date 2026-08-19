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
/**
 * Capped well below the provider's own 600s ceiling: generation happens inside a
 * time-limited serving function whose provider fetch carries its own abort
 * deadline (MUSIC_GENERATION_TIMEOUT_MS in ElevenLabsMusicGenerator). That abort
 * is what makes an over-budget request fail safe (reservation refunded); this cap
 * only avoids accepting lengths that would predictably hit it. Conservative and
 * provisional: raise it once real ElevenLabs generation latency is measured.
 * Note this bounds output length, which correlates with - but is not - wall time.
 */
export const MAX_MUSIC_LENGTH_MS = 120_000;

/**
 * Inbound request body for `POST /api/ai/music`.
 *
 * `lengthMs` upper bound is capped below the ElevenLabs Music API ceiling to fit
 * the serving function's time budget (see MAX_MUSIC_LENGTH_MS). It carries a
 * default rather than being optional so the billed
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
