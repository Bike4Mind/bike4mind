/**
 * Studio's image jobs (POST/GET /api/studio/image-jobs, apps/client/pages/api/studio/image-jobs). The route has no
 * per-job read, so the gallery list is the only cache: GenerationUpdatesListener patches its rows' state and refetches
 * it when a job finishes, which is what brings in the output file.
 */
import { isAxiosError } from 'axios';
import { useInfiniteQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { GenerationJobState, ImageJobRequest } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { invalidateGenerationCreditBalances } from './generationCreditBalances';
import { GENERATION_RATE_LIMITED_MESSAGE } from './generationErrors';
import { SOCKET_DOWN_POLL_MS, isTerminalGenerationState, movesLiveStateBackwards } from './generationJobPolling';

const STUDIO_IMAGE_JOBS_URL = '/api/studio/image-jobs';
export const IMAGE_GALLERY_PAGE_SIZE = 12;
// The route's own bounds on "make N".
export const STUDIO_IMAGE_COUNT_MAX = 4;

/** One job as the route returns it (toStudioImageJob); the error text is fixed per code server-side. */
export type StudioImageJob = {
  id: string;
  groupId: string | null;
  // 'cutout': a background removal of a reference (useCreateStudioImageCutout); null for a plain render.
  purpose: 'cutout' | null;
  state: GenerationJobState;
  request: ImageJobRequest;
  error: { code: string; message: string } | null;
  output: { fileId: string | null; contentType: string; bytes: number } | null;
  createdAt: string;
};

export type StudioImageJobPage = { data: StudioImageJob[]; next_cursor: string | null };
export type StudioImageJobList = { pages: StudioImageJobPage[]; pageParams: unknown[] };

export type CreateStudioImageJobsBody = { count: number; request: ImageJobRequest };

export const studioImageJobKeys = {
  all: ['studioImageJobs'] as const,
  list: ['studioImageJobs', 'list'] as const,
};

/** The gallery: the caller's image jobs, newest first. Polls only while the socket is down and a job is live. */
export function useStudioImageJobs() {
  const { readyState } = useWebsocket();
  const socketOpen = readyState === ReadyState.OPEN;
  return useInfiniteQuery({
    queryKey: studioImageJobKeys.list,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<StudioImageJobPage>(STUDIO_IMAGE_JOBS_URL, {
          params: { limit: IMAGE_GALLERY_PAGE_SIZE, ...(pageParam && { cursor: pageParam }) },
        })
      ).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next_cursor ?? undefined,
    refetchInterval: query => (shouldPollStudioImageJobs(socketOpen, query.state.data) ? SOCKET_DOWN_POLL_MS : false),
  });
}

/** The socket brings job updates; the gallery polls only while it is down and some job can still change. */
export const shouldPollStudioImageJobs = (socketOpen: boolean, list: StudioImageJobList | undefined): boolean =>
  !socketOpen && (list?.pages.some(page => page.data.some(job => !isTerminalGenerationState(job.state))) ?? false);

/** Puts a new batch at the top of page 1, skipping any job the list already holds (an idempotent replay). */
export const prependStudioImageJobs = (queryClient: QueryClient, jobs: readonly StudioImageJob[]): void => {
  // A gallery still loading may have read its page before these jobs existed, so it refetches instead.
  if (!queryClient.getQueryData(studioImageJobKeys.list)) {
    void queryClient.invalidateQueries({ queryKey: studioImageJobKeys.list });
    return;
  }
  queryClient.setQueryData<StudioImageJobList>(studioImageJobKeys.list, list => {
    if (!list) return list;
    const known = new Set(list.pages.flatMap(page => page.data.map(job => job.id)));
    const fresh = jobs.filter(job => !known.has(job.id));
    if (fresh.length === 0) return list;
    const [first, ...rest] = list.pages;
    return first ? { ...list, pages: [{ ...first, data: [...fresh, ...first.data] }, ...rest] } : list;
  });
};

/**
 * Applies a `generation_job_updated` frame's state to the cached row. Returns whether the job was in the list. A live
 * state never steps back and a terminal one is final, as for video and music (generationJobPolling.ts).
 */
export const patchStudioImageJob = (
  queryClient: QueryClient,
  update: { id: string; state: GenerationJobState }
): boolean => {
  let found = false;
  queryClient.setQueryData<StudioImageJobList>(studioImageJobKeys.list, list => {
    if (!list) return list;
    return {
      ...list,
      pages: list.pages.map(page => ({
        ...page,
        data: page.data.map(job => {
          if (job.id !== update.id) return job;
          found = true;
          const isStale = isTerminalGenerationState(job.state) || movesLiveStateBackwards(job.state, update.state);
          return isStale ? job : { ...job, state: update.state };
        }),
      })),
    };
  });
  return found;
};

// Keyed by the route's `error` code. Its `message` is never shown; FLUX and Grok answer model_unavailable until
// their job providers are wired.
const CREATE_ERROR_MESSAGES: Record<string, string> = {
  invalid_request: 'The request was not valid. Check the form and try again.',
  invalid_count: `Pick between 1 and ${STUDIO_IMAGE_COUNT_MAX} images.`,
  model_unavailable: 'This model is not available in Studio yet. Pick another model.',
  input_image_not_found: 'An input image could not be found.',
  unsupported_input_image: 'An input image is not a PNG, JPEG or WebP file.',
  insufficient_credits: 'You do not have enough credits for these images.',
  storage_quota_exceeded: 'Your file storage is full. Free up space in Files, then try again.',
  idempotency_key_reused: 'This request was already sent with different settings. Try again.',
};

type CreateErrorBody = { error?: unknown; failures?: unknown };

const readFailureReasons = (failures: unknown): string[] =>
  Array.isArray(failures)
    ? failures.flatMap(failure =>
        typeof failure === 'object' && failure !== null && 'reason' in failure && typeof failure.reason === 'string'
          ? [failure.reason]
          : []
      )
    : [];

/** The toast for a refused create: the model's why-not reasons for a 422, else the message for the route's code. */
export function describeStudioImageJobError(error: unknown): string {
  const fallback = 'Could not start the images. Try again.';
  if (!isAxiosError<CreateErrorBody>(error) || !error.response) return fallback;
  if (error.response.status === 429) return GENERATION_RATE_LIMITED_MESSAGE;
  const { error: code, failures } = error.response.data ?? {};
  if (code === 'unsupported_by_model') {
    const reasons = readFailureReasons(failures);
    return reasons.length > 0 ? reasons.join(' ') : 'This model cannot make that image. Change the settings.';
  }
  return typeof code === 'string' ? (CREATE_ERROR_MESSAGES[code] ?? fallback) : fallback;
}

export function useCreateStudioImageJobs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateStudioImageJobsBody) =>
      (await api.post<{ groupId: string; jobs: StudioImageJob[] }>(STUDIO_IMAGE_JOBS_URL, body)).data,
    onSuccess: ({ jobs }) => {
      prependStudioImageJobs(queryClient, jobs);
      void invalidateGenerationCreditBalances(queryClient);
      toast.success(jobs.length === 1 ? 'Image generation started' : `${jobs.length} images started`);
    },
    onError: error => toast.error(describeStudioImageJobError(error)),
  });
}

/**
 * The refusal text for a cutout: the route's own message for a source it cannot cut out (its format or size), else
 * the shared image-job message for the code.
 */
export function describeStudioImageCutoutError(error: unknown): string {
  if (isAxiosError<{ error?: unknown; message?: unknown }>(error) && error.response?.status === 422) {
    const { error: code, message } = error.response.data ?? {};
    if (code === 'unsupported_input_image' && typeof message === 'string') return message;
  }
  return describeStudioImageJobError(error);
}

/** Starts a background removal of one of the caller's images; the job joins the gallery list like any image job. */
export function useCreateStudioImageCutout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fileId: string) =>
      (await api.post<{ job: StudioImageJob }>(`${STUDIO_IMAGE_JOBS_URL}/cutouts`, { fileId })).data.job,
    onSuccess: job => {
      prependStudioImageJobs(queryClient, [job]);
      void invalidateGenerationCreditBalances(queryClient);
    },
  });
}
