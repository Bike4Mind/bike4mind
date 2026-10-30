import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ArenaNextResponse,
  ArenaPairImport,
  ArenaPairSource,
  ArenaStats,
  ArenaVoteRequest,
  ArenaVoteResponse,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { CREDITS_BALANCE_KEY } from './credits';

export const ARENA_NEXT_KEY = ['preference-arena', 'next'] as const;
const ARENA_ADMIN_KEY = ['admin', 'preference-arena'] as const;

export function useArenaNextPair() {
  return useQuery<ArenaNextResponse>({
    queryKey: ARENA_NEXT_KEY,
    queryFn: async () => (await api.get<ArenaNextResponse>('/api/preference-arena/next')).data,
    // Each fetch serves (and timestamps) a fresh pair, so it must never be reused from cache.
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
}

export function useArenaVote() {
  const queryClient = useQueryClient();
  return useMutation<ArenaVoteResponse, Error, ArenaVoteRequest>({
    mutationFn: async request => (await api.post<ArenaVoteResponse>('/api/preference-arena/vote', request)).data,
    onSuccess: result => {
      if (result.creditsAwarded > 0) {
        queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY });
        queryClient.invalidateQueries({ queryKey: ['credit-transactions'] });
      }
    },
  });
}

/** The admin list row. Kept in one place: adjust here if the list endpoint's shape changes. */
export type AdminArenaPair = {
  id: string;
  prompt: string;
  taskType: string;
  source: ArenaPairSource;
  active: boolean;
  isGold: boolean;
  modelIds: [string, string];
  createdAt: string;
};

export type AdminArenaPairsResponse = { rows: AdminArenaPair[]; page: number; limit: number; total: number };

export function useAdminArenaPairs(page: number, limit: number) {
  return useQuery<AdminArenaPairsResponse>({
    queryKey: [...ARENA_ADMIN_KEY, 'pairs', page, limit],
    queryFn: async () =>
      (await api.get<AdminArenaPairsResponse>('/api/admin/preference-arena/pairs', { params: { page, limit } })).data,
  });
}

export function useAdminArenaStats() {
  return useQuery<ArenaStats>({
    queryKey: [...ARENA_ADMIN_KEY, 'stats'],
    queryFn: async () => (await api.get<ArenaStats>('/api/admin/preference-arena/stats')).data,
  });
}

export function useImportArenaPairs() {
  const queryClient = useQueryClient();
  return useMutation<{ inserted: number }, Error, ArenaPairImport[]>({
    mutationFn: async pairs =>
      (await api.post<{ inserted: number }>('/api/admin/preference-arena/pairs', { pairs })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ARENA_ADMIN_KEY }),
  });
}

export function useSetArenaPairActive() {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { id: string; active: boolean }>({
    mutationFn: async ({ id, active }) =>
      (await api.patch(`/api/admin/preference-arena/pairs/${encodeURIComponent(id)}`, { active })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ARENA_ADMIN_KEY }),
  });
}
