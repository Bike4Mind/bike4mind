import { z } from 'zod';
import {
  ASPECT_RATIOS,
  RESOLUTION_TIERS,
  VIDEO_MODEL_CATALOG,
  type VideoModelCapabilities,
  type VideoModelId,
} from '@bike4mind/common';

const durationBounds = (caps: VideoModelCapabilities): { min: number; max: number } =>
  caps.duration.kind === 'range'
    ? { min: caps.duration.min, max: caps.duration.max }
    : { min: Math.min(...caps.duration.values), max: Math.max(...caps.duration.values) };

const describeDuration = (caps: VideoModelCapabilities): string =>
  caps.duration.kind === 'range'
    ? `${caps.duration.min}-${caps.duration.max}s`
    : `one of ${caps.duration.values.join('/')}s`;

const describeModel = (id: VideoModelId): string => {
  const caps = VIDEO_MODEL_CATALOG[id];
  return (
    `- ${id} (${caps.displayName}): ${caps.modes.join(', ')}; duration ${describeDuration(caps)}; ` +
    `aspect ${caps.aspectRatios.join(', ')}; resolution ${caps.resolutions.join(', ')}; ` +
    `renders in about ${caps.typicalRenderSeconds}s`
  );
};

const unionInCatalogOrder = <T extends string>(ordered: readonly T[], offered: readonly T[]): [T, ...T[]] => {
  const [first, ...rest] = ordered.filter(value => offered.includes(value));
  if (first === undefined) throw new Error('Usable video models declare no values for this option');
  return [first, ...rest];
};

// The schema is converted with z.toJSONSchema for the LLM, so keep it free of transforms, refinements and catch.
// Per-model duration strictness is enforced downstream by validateAgainstCapabilities in createVideoJob.
export function buildVideoToolSchema(usableModels: readonly [VideoModelId, ...VideoModelId[]]) {
  const bounds = usableModels.map(id => durationBounds(VIDEO_MODEL_CATALOG[id]));
  const min = Math.min(...bounds.map(b => b.min));
  const max = Math.max(...bounds.map(b => b.max));
  const usableCaps = usableModels.map(id => VIDEO_MODEL_CATALOG[id]);
  const aspectRatios = unionInCatalogOrder(
    ASPECT_RATIOS,
    usableCaps.flatMap(caps => caps.aspectRatios)
  );
  const resolutions = unionInCatalogOrder(
    RESOLUTION_TIERS,
    usableCaps.flatMap(caps => caps.resolutions)
  );
  const schema = z.object({
    model: z.enum(usableModels).describe('Which video model to use'),
    prompt: z.string().min(1).max(4000).describe('What the clip should show'),
    durationSeconds: z.number().int().min(min).max(max).optional().describe('Clip length; must fit the chosen model'),
    aspectRatio: z.enum(aspectRatios).optional(),
    resolution: z.enum(resolutions).optional(),
    inputImageFileId: z
      .string()
      .optional()
      .describe('Id of an uploaded image file to animate (image-to-video). Omit for text-to-video.'),
  });
  const description = [
    'Start generating a short video clip. Returns immediately with a job id; the clip renders in the background',
    'and appears in the reply as a card. Do not wait for it or promise a result time beyond the estimate.',
    'Available models:',
    ...usableModels.map(describeModel),
  ].join('\n');
  return { schema, description };
}

export type VideoToolArgs = z.infer<ReturnType<typeof buildVideoToolSchema>['schema']>;
