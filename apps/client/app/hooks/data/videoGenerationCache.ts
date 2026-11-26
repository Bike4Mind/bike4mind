/**
 * Every write into the video-generation cache. The list seed, the create and cancel responses and the websocket
 * listener all go through here; the ordering rules live in generationJobCache.ts, shared with music.
 */
import type { VideoGeneration } from '@bike4mind/common';
import {
  createGenerationJobCache,
  type GenerationJobList,
  type GenerationJobLiveUpdate,
  type GenerationJobPage,
} from './generationJobCache';
import { isTerminalGenerationState } from './generationJobPolling';
import { videoGenerationKeys } from './videoGenerationKeys';

export type VideoGenerationPage = GenerationJobPage<VideoGeneration>;
export type VideoGenerationList = GenerationJobList<VideoGeneration>;
export type VideoJobLiveUpdate = GenerationJobLiveUpdate & { progress?: number };

export const isTerminalVideoState = isTerminalGenerationState;

export const videoGenerationCache = createGenerationJobCache<VideoGeneration, VideoJobLiveUpdate>(
  videoGenerationKeys,
  (cached, update) => ({ ...cached, state: update.state, progress: update.progress ?? cached.progress })
);

export const seedVideoGeneration = videoGenerationCache.seed;
export const prependVideoGeneration = videoGenerationCache.prepend;
export const upsertVideoGeneration = videoGenerationCache.upsert;
export const reconcileFetchedVideoGeneration = videoGenerationCache.reconcileFetched;
export const reconcileFetchedVideoGenerationPage = videoGenerationCache.reconcileFetchedPage;
export const patchVideoGeneration = videoGenerationCache.patch;
