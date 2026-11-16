import {
  rankCandidates,
  type ModelRankingOptions,
  type RankedModel,
  type RankingCandidate,
} from '../generation/modelRanking';
import { MUSIC_MODEL_CATALOG, type MusicModelId } from './catalog';
import type { MusicGenerationRequest } from './request';
import { validateMusicRequest } from './validate';

/** What each music model is the pick for, as the "Picked for" line opens (see IMAGE_MODEL_FOCUS). */
export const MUSIC_MODEL_FOCUS: Record<MusicModelId, string> = {
  'test-music': 'pipeline testing',
  'lyria-3.5': 'full songs with vocals',
  'lyria-3-clip-preview': 'short sketches',
  music_v2_5: 'exact-length songs',
  music_v2: 'exact-length songs',
  music_v1: 'long lyrics',
};

/** The request a music model is ranked against: a create request without the model and prompt. */
export type MusicRankingRequest = Omit<MusicGenerationRequest, 'model' | 'prompt'>;

const isCatalogMusicId = (id: string): id is MusicModelId => Object.hasOwn(MUSIC_MODEL_CATALOG, id);

const musicStanding = (id: string) => (isCatalogMusicId(id) ? MUSIC_MODEL_CATALOG[id] : undefined);

const musicRequestSignals = (request: MusicRankingRequest): string[] => [
  ...(request.instrumental ? ['instrumental'] : []),
  ...(!request.instrumental && request.lyrics ? ['your lyrics'] : []),
  ...(request.durationSeconds !== undefined ? [`${request.durationSeconds}s length`] : []),
];

const toCandidate = (
  id: string,
  request: MusicRankingRequest,
  signals: readonly string[]
): RankingCandidate<string> => {
  if (!isCatalogMusicId(id)) return { id, mismatch: null, pickedFor: signals };
  const result = validateMusicRequest({ ...request, model: id, prompt: '' }, MUSIC_MODEL_CATALOG[id]);
  if (!result.ok) return { id, mismatch: { code: result.code, reason: result.reason }, pickedFor: [] };
  return { id, mismatch: null, pickedFor: [MUSIC_MODEL_FOCUS[id], ...signals] };
};

/**
 * Ranks music models for one request against MUSIC_MODEL_CATALOG with validateMusicRequest (the server's check, so
 * the why-not code is the one the route would answer with). Pure; see rankCandidates for the order.
 */
export const rankMusicModels = <TId extends string>(
  ids: readonly TId[],
  request: MusicRankingRequest,
  options?: ModelRankingOptions
): RankedModel<TId>[] => {
  const signals = musicRequestSignals(request);
  return rankCandidates(
    ids.map(id => ({ ...toCandidate(id, request, signals), id })),
    musicStanding,
    options
  );
};
