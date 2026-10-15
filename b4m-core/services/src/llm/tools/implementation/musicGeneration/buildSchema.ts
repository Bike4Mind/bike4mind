import { z } from 'zod';
import {
  MUSIC_MODEL_CATALOG,
  type MusicDurationCapability,
  type MusicModelCapabilities,
  type MusicModelId,
} from '@bike4mind/common';

const durationBounds = (duration: MusicDurationCapability): { min: number; max: number } =>
  duration.control === 'fixed' ? { min: duration.seconds, max: duration.seconds } : duration;

const describeDuration = (duration: MusicDurationCapability): string => {
  if (duration.control === 'fixed') return `always ${duration.seconds}`;
  const range = `${duration.min}-${duration.max}, default ${duration.default}`;
  return duration.control === 'exact' ? range : `${range}, approximate`;
};

const describeLyrics = (caps: MusicModelCapabilities): string =>
  caps.lyrics && caps.vocals !== 'never' ? `lyrics up to ${caps.lyrics.maxChars} chars` : 'no custom lyrics';

// Render time is left out on purpose: the tool result carries it, and every line here is paid on each turn.
const describeModel = (id: MusicModelId): string => {
  const caps = MUSIC_MODEL_CATALOG[id];
  const traits = [
    ...(caps.vocals === 'never' ? ['instrumental only'] : []),
    describeLyrics(caps),
    describeDuration(caps.duration),
  ];
  return `- ${id} (${caps.displayName}): ${traits.join('; ')}`;
};

// The schema is converted with z.toJSONSchema for the LLM, so keep it free of transforms, refinements and catch.
// Per-model duration and lyrics limits are enforced downstream by validateMusicRequest in createMusicJob.
export function buildMusicToolSchema(usableModels: readonly [MusicModelId, ...MusicModelId[]]) {
  const usableCaps = usableModels.map(id => MUSIC_MODEL_CATALOG[id]);
  const bounds = usableCaps.map(caps => durationBounds(caps.duration));
  const lyricsLimits = usableCaps.flatMap(caps =>
    caps.lyrics && caps.vocals !== 'never' ? [caps.lyrics.maxChars] : []
  );
  const schema = z.object({
    model: z.enum(usableModels).describe('Which music model to use'),
    prompt: z
      .string()
      .min(1)
      .max(4000)
      .describe('Genre, mood, instruments, tempo and structure of the song. Describe a style, never a real artist.'),
    ...(lyricsLimits.length > 0
      ? {
          lyrics: z
            .string()
            .min(1)
            .max(Math.max(...lyricsLimits))
            .optional()
            .describe(
              'Lyrics to sing. Pass lyrics the user wrote verbatim; omit to let the model write its own. ' +
                'Section tags such as [Verse] and [Chorus] are allowed.'
            ),
        }
      : {}),
    instrumental: z
      .boolean()
      .optional()
      .describe('true for no vocals. Prefer it for background music, soundtracks and jingles without words.'),
    durationSeconds: z
      .number()
      .int()
      .min(Math.min(...bounds.map(bound => bound.min)))
      .max(Math.max(...bounds.map(bound => bound.max)))
      .optional()
      .describe("Song length in seconds; must fit the chosen model. Omit for the model's default."),
  });
  const description = [
    'Start generating a song (vocal or instrumental). Returns a job id at once; the song renders in the background,',
    "shows in the reply as a player card and is saved to the user's Files. Do not wait for it. One call per song.",
    'Never name a real artist or band; describe the style. Not for speech or short sound effects.',
    'Models (durations in seconds):',
    ...usableModels.map(describeModel),
  ].join('\n');
  return { schema, description };
}

export type MusicToolArgs = z.infer<ReturnType<typeof buildMusicToolSchema>['schema']>;
