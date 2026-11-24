import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ISpendFreeze, SpendFreezeScope } from '@bike4mind/common';
import type { SpendMonitorOverview } from '@server/utils/spendMonitorAdmin';
import { api } from '@client/app/contexts/ApiContext';

export type { SpendIncidentRow, SpendMonitorOverview } from '@server/utils/spendMonitorAdmin';

const OVERVIEW_ENDPOINT = '/api/admin/spend-monitor';
const FREEZES_ENDPOINT = '/api/admin/spend-freezes';
/** The most the list route returns in one page. */
export const ACTIVE_FREEZES_LIMIT = 200;

export const SPEND_MONITOR_QUERY_KEY = ['admin-spend-monitor'] as const;
export const ACTIVE_SPEND_FREEZES_QUERY_KEY = ['admin-spend-freezes'] as const;

/** An active freeze as it arrives over JSON: the dates are ISO strings. */
export type ActiveSpendFreezeRow = Omit<ISpendFreeze, 'frozenAt' | 'liftedAt' | 'liftedBy' | 'liftReason'> & {
  frozenAt: string;
  label: string | null;
};
export type ActiveSpendFreezes = { items: ActiveSpendFreezeRow[]; nextCursor: string | null };

export type SpendFreezeRequest = SpendFreezeScope & { reason: string };
export type FreezeSpendResult = { freeze: ActiveSpendFreezeRow; created: boolean };
export type LiftSpendFreezeResult = { freeze: ActiveSpendFreezeRow; lifted: boolean };

export function useSpendMonitorOverview() {
  return useQuery({
    queryKey: SPEND_MONITOR_QUERY_KEY,
    queryFn: async () => (await api.get<SpendMonitorOverview>(OVERVIEW_ENDPOINT)).data,
    refetchInterval: 60_000,
  });
}

export function useActiveSpendFreezes() {
  return useQuery({
    queryKey: ACTIVE_SPEND_FREEZES_QUERY_KEY,
    queryFn: async () =>
      (await api.get<ActiveSpendFreezes>(FREEZES_ENDPOINT, { params: { limit: ACTIVE_FREEZES_LIMIT } })).data,
    // Matches the overview's interval, so an automatic pause shows up here as it does on the incident row.
    refetchInterval: 60_000,
  });
}

/** A freeze or lift changes both the incident rows' freeze state and the frozen list. */
function useInvalidateSpendMonitor() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: SPEND_MONITOR_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ACTIVE_SPEND_FREEZES_QUERY_KEY }),
    ]);
}

export function useFreezeSpend() {
  const invalidate = useInvalidateSpendMonitor();
  return useMutation({
    mutationFn: async (request: SpendFreezeRequest) =>
      (await api.post<FreezeSpendResult>(FREEZES_ENDPOINT, request)).data,
    onSettled: invalidate,
  });
}

export function useLiftSpendFreeze() {
  const invalidate = useInvalidateSpendMonitor();
  return useMutation({
    mutationFn: async (request: SpendFreezeRequest) =>
      (await api.post<LiftSpendFreezeResult>(`${FREEZES_ENDPOINT}/lift`, request)).data,
    onSettled: invalidate,
  });
}
