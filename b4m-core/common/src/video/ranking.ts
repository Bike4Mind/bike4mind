import {
  rankCandidates,
  type ModelRankingOptions,
  type RankedModel,
  type RankingCandidate,
} from '../generation/modelRanking';
import { VIDEO_MODEL_CATALOG, isVideoModelRetired, type VideoModelId } from './catalog';
import type { VideoGenerationRequest } from './request';
import { validateAgainstCapabilities } from './validate';

/** What each video model is the pick for, as the "Picked for" line opens (see IMAGE_MODEL_FOCUS). */
export const VIDEO_MODEL_FOCUS: Record<VideoModelId, string> = {
  'test-video': 'pipeline testing',
  'gemini-omni-1.1-flash': 'quick clips with sound',
  'grok-imagine-video-1.5': 'stylised motion',
  'veo-3.1-fast-generate-preview': 'cinematic motion',
  'flux-3-video': 'detailed scenes',
};

// House order among models that fit. Unlisted models (the test provider) follow in the caller's order.
export const VIDEO_MODEL_PREFERENCE: readonly VideoModelId[] = [
  'gemini-omni-1.1-flash',
  'grok-imagine-video-1.5',
  'flux-3-video',
  'veo-3.1-fast-generate-preview',
];

/** The request a video model is ranked against: a create request without the model and prompt. */
export type VideoRankingRequest = Omit<VideoGenerationRequest, 'model' | 'prompt'>;

const isCatalogVideoId = (id: string): id is VideoModelId => Object.hasOwn(VIDEO_MODEL_CATALOG, id);

const videoRequestSignals = (request: VideoRankingRequest): string[] => [
  ...(request.mode === 'image_to_video' ? ['your starting image'] : []),
  ...(request.audio ? ['sound'] : []),
];

const toCandidate = (
  id: string,
  request: VideoRankingRequest,
  signals: readonly string[]
): RankingCandidate<string> => {
  if (!isCatalogVideoId(id)) return { id, mismatch: null, pickedFor: signals };
  const result = validateAgainstCapabilities({ ...request, model: id, prompt: '' }, VIDEO_MODEL_CATALOG[id]);
  if (!result.ok) return { id, mismatch: { code: result.code, reason: result.reason }, pickedFor: [] };
  return { id, mismatch: null, pickedFor: [VIDEO_MODEL_FOCUS[id], ...signals] };
};

// A retired model is a catalog fact, so it ranks as unavailable without the caller having to say so.
const withRetired = (ids: readonly string[], options: ModelRankingOptions = {}): ModelRankingOptions => {
  const unavailable: Partial<Record<string, string>> = { ...options.unavailable };
  for (const id of ids) {
    if (isCatalogVideoId(id) && isVideoModelRetired(id) && unavailable[id] === undefined)
      unavailable[id] = 'Retired by its provider. Pick another model.';
  }
  return { ...options, unavailable };
};

/**
 * Ranks video models for one request against VIDEO_MODEL_CATALOG with validateAgainstCapabilities (the server's
 * check, so the why-not code is the one the route would answer with). Pure; see rankCandidates for the order.
 */
export const rankVideoModels = <TId extends string>(
  ids: readonly TId[],
  request: VideoRankingRequest,
  options?: ModelRankingOptions
): RankedModel<TId>[] => {
  const signals = videoRequestSignals(request);
  return rankCandidates(
    ids.map(id => ({ ...toCandidate(id, request, signals), id })),
    VIDEO_MODEL_PREFERENCE,
    withRetired(ids, options)
  );
};
