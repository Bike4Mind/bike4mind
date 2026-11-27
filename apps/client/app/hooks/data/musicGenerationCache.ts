/** Every write into the music-generation cache; the ordering rules live in generationJobCache.ts, shared with video. */
import type { MusicGeneration } from '@bike4mind/common';
import {
  createGenerationJobCache,
  type GenerationJobList,
  type GenerationJobLiveUpdate,
  type GenerationJobPage,
} from './generationJobCache';
import { musicGenerationKeys } from './musicGenerationKeys';

export type MusicGenerationPage = GenerationJobPage<MusicGeneration>;
export type MusicGenerationList = GenerationJobList<MusicGeneration>;
export type MusicJobLiveUpdate = GenerationJobLiveUpdate;

export const musicGenerationCache = createGenerationJobCache<MusicGeneration, MusicJobLiveUpdate>(
  musicGenerationKeys,
  (cached, update) => ({ ...cached, state: update.state })
);

export const seedMusicGeneration = musicGenerationCache.seed;
export const prependMusicGeneration = musicGenerationCache.prepend;
export const upsertMusicGeneration = musicGenerationCache.upsert;
export const reconcileFetchedMusicGeneration = musicGenerationCache.reconcileFetched;
export const reconcileFetchedMusicGenerationPage = musicGenerationCache.reconcileFetchedPage;
export const patchMusicGeneration = musicGenerationCache.patch;
