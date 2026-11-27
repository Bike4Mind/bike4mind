import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';
import type { ReferralLinkResponse } from '@server/referrals/shareLink';

export type { ReferralLinkResponse } from '@server/referrals/shareLink';

export const REFERRAL_LINK_KEY = ['referral-link'] as const;

export async function fetchReferralLink(): Promise<ReferralLinkResponse> {
  const response = await api.get<ReferralLinkResponse>('/api/referrals/link');
  return response.data;
}

/** The user's share link. An unverified account is refused, so a failure just leaves the link out. */
export function useGetReferralLink(options: { enabled?: boolean } = {}) {
  return useQuery<ReferralLinkResponse>({
    queryKey: REFERRAL_LINK_KEY,
    queryFn: fetchReferralLink,
    enabled: options.enabled,
    retry: false,
    staleTime: Infinity,
  });
}
