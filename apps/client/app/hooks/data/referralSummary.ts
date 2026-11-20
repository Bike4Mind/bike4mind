import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';
import type { InviterSummary } from '@server/referrals/inviterSummary';

export type { InviterSummary, InviterRecentReward } from '@server/referrals/inviterSummary';

export const REFERRAL_SUMMARY_KEY = ['referral-summary'] as const;

export async function fetchReferralSummary(): Promise<InviterSummary> {
  const response = await api.get<InviterSummary>('/api/referrals/summary');
  return response.data;
}

export function useGetReferralSummary(options: { enabled?: boolean } = {}) {
  return useQuery<InviterSummary>({
    queryKey: REFERRAL_SUMMARY_KEY,
    queryFn: fetchReferralSummary,
    enabled: options.enabled,
    staleTime: 1000 * 60 * 5,
  });
}
