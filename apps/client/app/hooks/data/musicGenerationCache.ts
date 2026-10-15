/**
 * Writes into the music-generation cache. There is no list cache yet, so the detail entry is the only target; it
 * follows the same ordering rules as videoGenerationCache.ts (see generationJobPolling.ts).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { GenerationJobState, MusicGeneration } from '@bike4mind/common';
import { isTerminalGenerationState, movesLiveStateBackwards, shouldReplaceGenerationJob } from './generationJobPolling';
import { musicGenerationKeys } from './musicGenerationKeys';

export type MusicJobLiveUpdate = { id: string; state: GenerationJobState };

/** Writes an authoritative server response (the cancel mutation) unless the cache already holds something newer. */
export function upsertMusicGeneration(queryClient: QueryClient, job: MusicGeneration): void {
  const key = musicGenerationKeys.detail(job.id);
  if (shouldReplaceGenerationJob(queryClient.getQueryData<MusicGeneration>(key), job)) {
    queryClient.setQueryData(key, job);
  }
}

/** Applies a websocket frame's state. Returns whether the job was cached. */
export function patchMusicGeneration(queryClient: QueryClient, update: MusicJobLiveUpdate): boolean {
  const key = musicGenerationKeys.detail(update.id);
  const cached = queryClient.getQueryData<MusicGeneration>(key);
  if (!cached) return false;
  // Frames can arrive out of order; a finished job stays finished and a live one never steps back.
  if (!isTerminalGenerationState(cached.state) && !movesLiveStateBackwards(cached.state, update.state)) {
    queryClient.setQueryData<MusicGeneration>(key, { ...cached, state: update.state });
  }
  return true;
}
