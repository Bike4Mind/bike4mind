import { z } from 'zod';
import { MusicModelIdSchema } from './catalog';
import { MAX_MUSIC_LYRICS_CHARS } from './types';

export const MusicGenerationRequestSchema = z.object({
  model: MusicModelIdSchema,
  prompt: z.string().trim().min(1).max(4000),
  lyrics: z.string().trim().min(1).max(MAX_MUSIC_LYRICS_CHARS).optional(),
  instrumental: z.boolean().optional(),
  durationSeconds: z.number().int().positive().optional(),
});
export type MusicGenerationRequest = z.infer<typeof MusicGenerationRequestSchema>;

declare const validatedBrand: unique symbol;
/**
 * Only validateMusicRequest produces this, so a provider can never receive an unchecked request. Defaults are
 * resolved: `durationSeconds` is the length to ask for (and hold credits on), `instrumental` is explicit.
 */
export type ValidatedMusicRequest = MusicGenerationRequest & {
  durationSeconds: number;
  instrumental: boolean;
  readonly [validatedBrand]: true;
};
