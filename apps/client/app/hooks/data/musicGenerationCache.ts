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

const musicCache = createGenerationJobCache<MusicGeneration, MusicJobLiveUpdate>(
  musicGenerationKeys,
  (cached, update) => ({ ...cached, state: update.state })
);

export const seedMusicGeneration = musicCache.seed;
export const prependMusicGeneration = musicCache.prepend;
export const upsertMusicGeneration = musicCache.upsert;
export const reconcileFetchedMusicGeneration = musicCache.reconcileFetched;
export const reconcileFetchedMusicGenerationPage = musicCache.reconcileFetchedPage;
export const patchMusicGeneration = musicCache.patch;
