/**
 * Studio Productions' compositions (apps/client/pages/api/studio/compositions). Owner-only and behind the
 * productions flag server-side; the routes return dates as strings, so responses go through the shared schemas.
 */
import { isAxiosError } from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  StudioCompositionResponseSchema,
  StudioCompositionSummaryResponseSchema,
  type StudioCompositionCreateBody,
  type StudioCompositionResponse,
  type StudioCompositionSummaryResponse,
  type StudioCompositionUpdateBody,
  type StudioTimelineIssue,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

const COMPOSITIONS_URL = '/api/studio/compositions';

export const studioCompositionKeys = {
  all: ['studioCompositions'] as const,
  list: ['studioCompositions', 'list'] as const,
  detail: (id: string) => ['studioCompositions', 'detail', id] as const,
};

const parseComposition = (body: unknown): StudioCompositionResponse =>
  StudioCompositionResponseSchema.parse((body as { composition: unknown }).composition);

export function useStudioCompositions() {
  return useQuery({
    queryKey: studioCompositionKeys.list,
    queryFn: async (): Promise<StudioCompositionSummaryResponse[]> => {
      const { data } = await api.get<{ data: unknown[] }>(COMPOSITIONS_URL);
      return data.data.map(row => StudioCompositionSummaryResponseSchema.parse(row));
    },
  });
}

export function useStudioComposition(id: string) {
  return useQuery({
    queryKey: studioCompositionKeys.detail(id),
    queryFn: async () => parseComposition((await api.get(`${COMPOSITIONS_URL}/${id}`)).data),
    // The editor holds the draft; a background refetch must not swap the timeline out from under it.
    refetchOnWindowFocus: false,
  });
}

/** The route's message, or a generic one: what a toast or the editor's save status shows. */
export const compositionErrorMessage = (error: unknown): string => {
  if (isAxiosError(error)) {
    const message: unknown = error.response?.data?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Something went wrong. Try again.';
};

const isIssue = (value: unknown): value is StudioTimelineIssue =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { message?: unknown }).message === 'string' &&
  Array.isArray((value as { path?: unknown }).path);

/**
 * The spec issues a 422 carries. The browser validates without file context, so these are the checks only the
 * server can run (a file it cannot read, a file kind that does not fit its track, a trim past the source's end).
 */
export const compositionErrorIssues = (error: unknown): StudioTimelineIssue[] => {
  if (!isAxiosError(error) || error.response?.status !== 422) return [];
  const body: unknown = error.response.data;
  if (typeof body !== 'object' || body === null) return [];
  const record = body as Record<string, unknown>;
  const nested = [record.issues, (record.details as Record<string, unknown> | undefined)?.issues];
  const issues = nested.find(Array.isArray) ?? [];
  return (issues as unknown[]).filter(isIssue);
};

export function useCreateStudioComposition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: StudioCompositionCreateBody) =>
      parseComposition((await api.post(COMPOSITIONS_URL, body)).data),
    onSuccess: composition => {
      queryClient.setQueryData(studioCompositionKeys.detail(composition.id), composition);
      void queryClient.invalidateQueries({ queryKey: studioCompositionKeys.list });
    },
    onError: error => toast.error(compositionErrorMessage(error)),
  });
}

/** Saves a partial update. Errors are left to the caller: the editor shows them in its save status, not a toast. */
export function useUpdateStudioComposition(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: StudioCompositionUpdateBody) =>
      parseComposition((await api.patch(`${COMPOSITIONS_URL}/${id}`, body)).data),
    onSuccess: composition => {
      queryClient.setQueryData(studioCompositionKeys.detail(id), composition);
      void queryClient.invalidateQueries({ queryKey: studioCompositionKeys.list });
    },
  });
}

export function useDeleteStudioComposition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`${COMPOSITIONS_URL}/${id}`);
      return id;
    },
    onSuccess: id => {
      queryClient.removeQueries({ queryKey: studioCompositionKeys.detail(id) });
      queryClient.setQueryData<StudioCompositionSummaryResponse[]>(studioCompositionKeys.list, rows =>
        rows?.filter(row => row.id !== id)
      );
    },
    onError: error => toast.error(compositionErrorMessage(error)),
  });
}
