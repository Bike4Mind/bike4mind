import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { buildUnavailableTool, toToolParameters } from '../generationJobTool';
import { isProductionToolConfig, type ProductionToolConfig } from './config';
import {
  buildCaptionClips,
  buildVideoClips,
  directorClips,
  layoutShots,
  musicShortfallMs,
  shotPicture,
  withDirectorTracks,
} from './layout';
import { CompositionIdArg, ProductionToolError, describeProductionError } from './shared';

const schema = z.object({
  compositionId: CompositionIdArg,
  captions: z.boolean().optional().describe('Caption each shot with its voice line. Default true.'),
});
type AssembleArgs = z.infer<typeof schema>;

const description =
  "Lay out the cut of a Studio production on its timeline: each shot's clip (or its chosen still) end to end in " +
  'shot order, captions from the voice lines, and the audio already added, all fitted to the shots. Run it last; ' +
  'then tell the user the production is ready to preview in Studio.';

async function assemble(config: ProductionToolConfig, args: AssembleArgs): Promise<string> {
  const composition = await config.compositions.get(args.compositionId);
  const { slots, totalMs } = layoutShots(composition.shots);
  if (slots.length === 0) throw new ProductionToolError('the production has no shots; storyboard it first.');
  const missing = slots.filter(slot => !shotPicture(slot.shot)).map(slot => slot.shot.id);
  if (missing.length === slots.length) {
    throw new ProductionToolError('no shot has a take yet; call production_generate_shot first.');
  }
  const musicShortMs = musicShortfallMs(composition.timeline, totalMs);
  const video = buildVideoClips(slots);
  const captions = args.captions === false ? [] : buildCaptionClips(slots);
  const timeline = withDirectorTracks(composition.timeline, { video, captions }, totalMs);
  await config.compositions.update(args.compositionId, { timeline });
  return JSON.stringify({
    durationSeconds: totalMs / 1000,
    clips: video.length,
    stills: slots.filter(slot => !slot.shot.clipFileId && slot.shot.chosenFileId).map(slot => slot.shot.id),
    captions: captions.length,
    audio: {
      music: directorClips(timeline, 'music').length,
      voice: directorClips(timeline, 'voice').length,
      sfx: directorClips(timeline, 'sfx').length,
    },
    ...(missing.length > 0 && { shotsWithoutTakes: missing }),
    ...(musicShortMs > 0 && { musicEndsBeforeCutMs: musicShortMs }),
    next:
      'Tell the user the cut is on the timeline and ready to preview in Studio > Productions. Say plainly what is ' +
      'missing or short: stills, a music bed that ends before the cut, voice lines a tool reported cut, and any ' +
      'part that failed.',
  });
}

export const productionAssembleTool: ToolDefinition = {
  name: 'production_assemble',
  implementation: (context: Omit<ToolContext, 'config'>, config: unknown) => {
    if (!isProductionToolConfig(config)) return buildUnavailableTool('production_assemble', 'Studio Productions');
    return {
      toolFn: async (parameters?: unknown) => {
        const args = schema.parse(parameters);
        try {
          return await assemble(config, args);
        } catch (error) {
          return describeProductionError(error, context.logger, 'production_assemble');
        }
      },
      toolSchema: { name: 'production_assemble', description, parameters: toToolParameters(schema) },
    };
  },
};
