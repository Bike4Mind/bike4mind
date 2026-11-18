import { z } from 'zod';
import {
  STUDIO_COMPOSITION_LIMITS,
  STUDIO_TIMELINE_LIMITS,
  StudioFileIdSchema,
  type StudioShot,
} from '@bike4mind/common';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildUnavailableTool, toToolParameters } from '../generationJobTool';
import { isProductionToolConfig } from './config';
import { DIRECTOR_TRACK_IDS, withDirectorTracks } from './layout';
import { CompositionIdArg, ProductionToolError, describeProductionError } from './shared';

export const STORYBOARD_MAX_SHOTS = 12;
const limits = STUDIO_COMPOSITION_LIMITS;

const ShotArg = z.object({
  title: z.string().trim().min(1).max(limits.shotTitleMaxLength).describe('A short name, e.g. "Hook".'),
  intent: z
    .string()
    .trim()
    .max(limits.shotIntentMaxLength)
    .optional()
    .describe('What the shot is for, e.g. "hook", "product reveal", "call to action".'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(limits.shotPromptMaxLength)
    .describe('The image prompt for the key frame: subject, setting, light, camera. Describe the product in it.'),
  durationSeconds: z.number().min(1).max(30).describe('How long the shot runs in the cut.'),
  voiceLine: z
    .string()
    .trim()
    .max(limits.shotVoiceLineMaxLength)
    .optional()
    .describe(
      'The voiceover line spoken over this shot; it also becomes the caption. Keep it short enough to say ' +
        'within the shot, about 2 words per second (8 words for a 4 second shot): a longer line is cut.'
    ),
});

const schema = z.object({
  compositionId: CompositionIdArg,
  brief: z
    .string()
    .trim()
    .min(1)
    .max(limits.briefSummaryMaxLength)
    .optional()
    .describe("The one-line brief to save on the production, when the user gave one that isn't saved yet."),
  productFileId: StudioFileIdSchema.optional().describe(
    'The product photo (a Files id) to keep in every shot; saved to the brand kit.'
  ),
  shots: z.array(ShotArg).min(1).max(STORYBOARD_MAX_SHOTS),
  replace: z
    .boolean()
    .optional()
    .describe('Set true to change the prompt of, or remove, shots that already have takes. Their takes stay in Files.'),
});
type StoryboardArgs = z.infer<typeof schema>;

const description =
  'Write the storyboard of a Studio production: the shots in order, each with an image prompt, its length and its ' +
  'voiceover line. Replaces the shot list; a shot whose prompt is unchanged keeps its takes, and its clip unless the ' +
  'shot gets longer. Plan about 4 shots for a 15 second ad (hook, product, benefit, call to action). Then call ' +
  'production_generate_shot.';

const toShot = (shot: StoryboardArgs['shots'][number], index: number): StudioShot => ({
  id: `shot-${index + 1}`,
  title: shot.title,
  ...(shot.intent && { intent: shot.intent }),
  prompt: shot.prompt,
  durationMs: Math.round(shot.durationSeconds * 1000),
  ...(shot.voiceLine && { voiceLine: shot.voiceLine }),
  fileIds: [],
});

/**
 * A shot whose image prompt is unchanged keeps its takes, so a re-run that only retimes shots or rewrites their
 * voice lines costs nothing. Its clip stays only while the shot is no longer than before: generate_shot already
 * cut the shot to its clip's length, so a longer shot would play past the clip's end.
 */
function keepTakes(shot: StudioShot, previous: StudioShot | undefined): { shot: StudioShot; clipDropped: boolean } {
  if (!previous || previous.fileIds.length === 0 || previous.prompt !== shot.prompt) {
    return { shot, clipDropped: false };
  }
  const keepClip = previous.clipFileId !== undefined && (shot.durationMs ?? 0) <= (previous.durationMs ?? 0);
  return {
    shot: {
      ...shot,
      fileIds: previous.fileIds,
      ...(previous.chosenFileId && { chosenFileId: previous.chosenFileId }),
      ...(keepClip && { clipFileId: previous.clipFileId }),
    },
    clipDropped: previous.clipFileId !== undefined && !keepClip,
  };
}

export const productionStoryboardTool: ToolDefinition = {
  name: 'production_storyboard',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isProductionToolConfig(config)) return buildUnavailableTool('production_storyboard', 'Studio Productions');
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        try {
          const totalMs = args.shots.reduce((sum, shot) => sum + Math.round(shot.durationSeconds * 1000), 0);
          if (totalMs > STUDIO_TIMELINE_LIMITS.maxDurationMs) {
            throw new ProductionToolError('the shots run longer than a production can.');
          }
          const current = await config.compositions.get(args.compositionId);
          const kept = args.shots.map((shot, index) => keepTakes(toShot(shot, index), current.shots[index]));
          const shots = kept.map(({ shot }) => shot);
          const keptTakeIds = new Set(shots.flatMap(shot => shot.fileIds));
          const lostTakes = current.shots.some(
            shot => shot.fileIds.length > 0 && !shot.fileIds.every(fileId => keptTakeIds.has(fileId))
          );
          if (!args.replace && lostTakes) {
            throw new ProductionToolError(
              'this storyboard changes or removes shots that already have takes. Keep their prompts to keep the ' +
                'takes; otherwise ask the user before replacing them, then pass replace: true.'
            );
          }
          const products = current.brandKit.productFileIds;
          const product = args.productFileId?.toLowerCase();
          const directorIds = new Set<string>(Object.values(DIRECTOR_TRACK_IDS));
          // The old cut's picture, captions and audio were laid to the old shots, so a new storyboard clears them.
          const staleCut = current.timeline.tracks.some(track => directorIds.has(track.id) && track.clips.length > 0);
          await config.compositions.update(args.compositionId, {
            shots,
            ...(staleCut && {
              timeline: withDirectorTracks(
                current.timeline,
                { video: [], music: [], voice: [], sfx: [], captions: [] },
                totalMs
              ),
            }),
            ...(args.brief && { brief: { ...current.brief, summary: args.brief } }),
            ...(product &&
              !products.includes(product) && {
                brandKit: {
                  ...current.brandKit,
                  productFileIds: [product, ...products].slice(0, STUDIO_COMPOSITION_LIMITS.brandProductFilesMax),
                },
              }),
          });
          const clipsDropped = kept.filter(({ clipDropped }) => clipDropped).map(({ shot }) => shot.id);
          return JSON.stringify({
            shots: shots.map(shot => ({
              id: shot.id,
              title: shot.title,
              durationMs: shot.durationMs,
              ...(shot.fileIds.length > 0 && { takesKept: true }),
            })),
            totalSeconds: totalMs / 1000,
            ...(clipsDropped.length > 0 && { clipsDropped }),
            next:
              'Call production_generate_shot to make the takes and clips; a shot that kept its takes is skipped ' +
              'unless it needs a clip.',
          });
        } catch (error) {
          return describeProductionError(error);
        }
      },
      toolSchema: { name: 'production_storyboard', description, parameters: toToolParameters(schema) },
    };
  },
};
