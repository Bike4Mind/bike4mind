import { ImageModels } from '../models';
import {
  rankCandidates,
  type ModelRankingOptions,
  type RankedModel,
  type RankingCandidate,
} from '../generation/modelRanking';
import { IMAGE_MODEL_CATALOG } from './catalog';
import { validateImageRequest, type ImageCapabilityRequest } from './validate';

/**
 * What each image model is the pick for, as the "Picked for" line opens. Short and lower-case: request signals are
 * appended to it ("product photoreal + reference"). Keyed by ImageModels so a new model fails to compile without one.
 */
export const IMAGE_MODEL_FOCUS: Record<ImageModels, string> = {
  [ImageModels.GPT_IMAGE_1]: 'legible text',
  [ImageModels.GPT_IMAGE_1_5]: 'sharp detail and text',
  [ImageModels.GPT_IMAGE_1_MINI]: 'quick drafts',
  [ImageModels.GPT_IMAGE_2]: 'posters and layouts',
  [ImageModels.GPT_IMAGE_2_5_SUNBURST]: 'finished artwork',
  [ImageModels.GPT_IMAGE_2_5_FLARE]: 'vivid styles',
  [ImageModels.DALL_E_2]: 'legacy workflows',
  [ImageModels.FLUX_PRO]: 'photoreal',
  [ImageModels.FLUX_PRO_1_1]: 'fast photoreal',
  [ImageModels.FLUX_PRO_ULTRA]: 'high-res photoreal',
  [ImageModels.FLUX_PRO_FILL]: 'masked fills',
  [ImageModels.FLUX_KONTEXT_PRO]: 'instruction edits',
  [ImageModels.FLUX_KONTEXT_MAX]: 'precise edits',
  [ImageModels.FLUX_2_MAX]: 'product photoreal',
  [ImageModels.FLUX_2_PRO]: 'balanced photoreal',
  [ImageModels.FLUX_2_PRO_PREVIEW]: 'photoreal preview',
  [ImageModels.FLUX_2_FLEX]: 'typography',
  [ImageModels.FLUX_2_KLEIN_9B]: 'fast iterations',
  [ImageModels.FLUX_2_KLEIN_9B_PREVIEW]: 'fast iterations',
  [ImageModels.FLUX_2_KLEIN_4B]: 'lowest cost',
  [ImageModels.FLUX_3_IMAGE]: 'detailed scenes',
  [ImageModels.FLUX_3_IMAGE_KLEIN]: 'fast, low cost',
  [ImageModels.GROK_IMAGINE_IMAGE_QUALITY]: 'stylised looks',
  [ImageModels.GEMINI_2_5_FLASH_IMAGE]: 'quick blends',
  [ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW]: 'composition preview',
  [ImageModels.GEMINI_3_1_FLASH_IMAGE]: 'fast text rendering',
  [ImageModels.GEMINI_3_PRO_IMAGE]: 'multi-image composition',
};

// House order among models that fit: quality per credit first. Unlisted models follow in the caller's order.
export const IMAGE_MODEL_PREFERENCE: readonly ImageModels[] = [
  ImageModels.GPT_IMAGE_1_5,
  ImageModels.GPT_IMAGE_2,
  ImageModels.GEMINI_3_1_FLASH_IMAGE,
  ImageModels.GEMINI_3_PRO_IMAGE,
  ImageModels.FLUX_2_PRO,
  ImageModels.FLUX_2_MAX,
  ImageModels.FLUX_PRO_ULTRA,
  ImageModels.FLUX_3_IMAGE,
  ImageModels.GPT_IMAGE_1_MINI,
];

const isCatalogImageId = (id: string): id is ImageModels => Object.hasOwn(IMAGE_MODEL_CATALOG, id);

/** The parts of the request a model was picked for, in the order the "Picked for" line lists them. */
const imageRequestSignals = (request: ImageCapabilityRequest): string[] => {
  const references = request.inputs?.filter(input => input.role === 'reference').length ?? 0;
  return [
    ...(request.mode === 'edit' ? ['editing'] : []),
    ...(references === 1 ? ['reference'] : references > 1 ? [`${references} references`] : []),
    ...(request.transparentBackground ? ['transparent background'] : []),
    ...(request.aspectRatio ? [`${request.aspectRatio} frame`] : []),
  ];
};

const toCandidate = (
  id: string,
  request: ImageCapabilityRequest,
  signals: readonly string[]
): RankingCandidate<string> => {
  // An id this build's catalog does not know (a newer server) cannot be checked here; the server still validates.
  if (!isCatalogImageId(id)) return { id, mismatch: null, pickedFor: signals };
  const result = validateImageRequest(request, IMAGE_MODEL_CATALOG[id]);
  if (!result.ok) {
    const [first] = result.failures;
    return { id, mismatch: { code: first.code, reason: first.reason }, pickedFor: [] };
  }
  return { id, mismatch: null, pickedFor: [IMAGE_MODEL_FOCUS[id], ...signals] };
};

/**
 * Ranks image models for one request: each is checked against IMAGE_MODEL_CATALOG with validateImageRequest (the
 * server's own check, so the why-not code is the one the job route would answer with), then ordered by
 * rankCandidates. Pure: the same ids and request always give the same list.
 */
export const rankImageModels = <TId extends string>(
  ids: readonly TId[],
  request: ImageCapabilityRequest,
  options?: ModelRankingOptions
): RankedModel<TId>[] => {
  const signals = imageRequestSignals(request);
  return rankCandidates(
    ids.map(id => ({ ...toCandidate(id, request, signals), id })),
    IMAGE_MODEL_PREFERENCE,
    options
  );
};
