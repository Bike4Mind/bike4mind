import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import type { AiAbuseAdvisory, AiAdvisorySummary } from '@client/app/utils/aiAdvisory';

const ENDPOINT = '/api/admin/shadow-detections/ai-advisory';
export const AI_ADVISORY_QUERY_KEY = ['admin-ai-advisory'];
// ms. The sweep runs on a schedule, so a minute of staleness hides nothing an admin could act on.
const STALE_MS = 60_000;

/** An advisory as it arrives over JSON: the dates are ISO strings. */
export type AiAbuseAdvisoryRow = Omit<AiAbuseAdvisory, 'assessedAt'> & { assessedAt: string };
export type AiAdvisorySummaryResponse = Omit<AiAdvisorySummary, 'since' | 'advisories'> & {
  since: string;
  advisories: AiAbuseAdvisoryRow[];
};

/** The AI advisory: the dashboard strip and the Users list's badge share this one fetch. */
export function useAiAdvisory() {
  return useQuery({
    queryKey: AI_ADVISORY_QUERY_KEY,
    queryFn: async () => (await api.get<AiAdvisorySummaryResponse>(ENDPOINT)).data,
    staleTime: STALE_MS,
    // An admin without support:read gets a 403 on every try; the advisory just stays hidden for them.
    retry: (failureCount, error) => !(isAxiosError(error) && error.response?.status === 403) && failureCount < 2,
  });
}
