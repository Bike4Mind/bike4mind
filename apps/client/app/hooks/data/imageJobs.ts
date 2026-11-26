import { isAxiosError } from 'axios';
import type { QueryClient } from '@tanstack/react-query';
import type { GenerationJobSource, GenerationJobState } from '@bike4mind/common';
import { movesLiveStateBackwards, isTerminalGenerationState } from './generationJobPolling';

/** One image job a chat tool call started, as GET /api/image-jobs/:id returns it. */
export type ChatImageJob = {
  id: string;
  object: 'image_generation';
  state: GenerationJobState;
  model: string;
  mode: 'generate' | 'edit';
  prompt: string;
  group_id: string | null;
  source: GenerationJobSource;
  error: { code: string; message: string } | null;
  output: {
    availability: 'ready' | 'pending_scan' | 'unavailable';
    url: string | null;
    expires_at: string | null;
    content_type: string;
    file_id: string | null;
  } | null;
  credits: { reserved: number | null; settled: number | null };
  created_at: string;
  updated_at: string;
};

export const chatImageJobKeys = {
  details: ['chatImageJobs', 'detail'] as const,
  detail: (id: string) => ['chatImageJobs', 'detail', id] as const,
};

/**
 * Applies a `generation_job_updated` frame to a cached chat image job. Returns whether the job was cached. A live
 * state never steps back and a terminal one is final, as for the other job kinds (generationJobPolling.ts).
 */
export const patchChatImageJob = (
  queryClient: QueryClient,
  update: { id: string; state: GenerationJobState }
): boolean => {
  const cached = queryClient.getQueryData<ChatImageJob>(chatImageJobKeys.detail(update.id));
  if (!cached) return false;
  const isStale = isTerminalGenerationState(cached.state) || movesLiveStateBackwards(cached.state, update.state);
  if (!isStale)
    queryClient.setQueryData<ChatImageJob>(chatImageJobKeys.detail(update.id), { ...cached, state: update.state });
  return true;
};

const statusOf = (error: unknown): number | undefined => (isAxiosError(error) ? error.response?.status : undefined);

const MAX_RATE_LIMITED_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 30_000;
/** A card whose first load failed retries this slowly, for at most MAX_ERRORED_RELOADS failed loads (~10 min). */
export const ERRORED_RELOAD_MS = 60_000;
export const MAX_ERRORED_RELOADS = 10;

/** 404 is final (no such job, or not the caller's to read); a 429 backs off longer than other errors. */
export const shouldRetryImageJob = (failureCount: number, error: unknown): boolean => {
  const status = statusOf(error);
  if (status === 404) return false;
  return failureCount < (status === 429 ? MAX_RATE_LIMITED_RETRIES : 3);
};

export const imageJobRetryDelay = (failureCount: number): number =>
  Math.min(1000 * 2 ** failureCount, MAX_RETRY_DELAY_MS);
