import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import {
  CampaignWatchDetailSchema,
  CampaignWatchPageSchema,
  CampaignWatchSchema,
  type CampaignWatchChange,
  type CampaignWatchCreate,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

const ENDPOINT = '/api/admin/campaign-watches';
const QUERY_KEY = ['admin', 'campaign-watches'];

export const watchErrorMessage = (error: unknown): string => {
  if (isAxiosError<{ error?: unknown }>(error)) {
    const message = error.response?.data?.error;
    return typeof message === 'string' ? message : error.message;
  }
  return error instanceof Error ? error.message : 'The watch could not be updated.';
};

export const useCampaignWatches = (status: 'open' | 'closed', enabled: boolean) =>
  useInfiniteQuery({
    queryKey: [...QUERY_KEY, 'list', status],
    queryFn: async ({ pageParam }) =>
      CampaignWatchPageSchema.parse(
        (await api.get(ENDPOINT, { params: { status, ...(pageParam ? { cursor: pageParam } : {}) } })).data
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
    staleTime: 30_000,
    enabled,
  });

export const useCampaignWatch = (id: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: [...QUERY_KEY, 'detail', id],
    queryFn: async () => CampaignWatchDetailSchema.parse((await api.get(`${ENDPOINT}/${id}`)).data),
    enabled: enabled && !!id,
    staleTime: 30_000,
  });

export const useCreateCampaignWatch = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CampaignWatchCreate) => {
      const response = await api.post<{ watch: unknown; created: boolean }>(ENDPOINT, input);
      return { watch: CampaignWatchSchema.parse(response.data.watch), created: response.data.created };
    },
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useChangeCampaignWatch = (id: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CampaignWatchChange) =>
      CampaignWatchSchema.parse((await api.patch(`${ENDPOINT}/${id}`, input)).data),
    onSuccess: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: () => client.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};
