import { OrgFeedbackReport } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';

export interface OrgFeedbackRange {
  /** Whole days, `YYYY-MM-DD`; the route rounds them out and echoes the resolved window back. */
  from: string;
  to: string;
}

export const orgFeedbackReportQueryKeys = {
  all: ['org-feedback-report'] as const,
  report: (orgId: string, from: string, to: string) => ['org-feedback-report', orgId, from, to] as const,
};

/**
 * The org feedback counts for a window. Deliberately not fired on mount: the aggregate is the most
 * expensive read in this area and the route rate limits it, so the caller decides when it runs by
 * flipping `enabled` - which is also what makes each window a separately cached answer.
 */
export function useOrgFeedbackReport(orgId: string, range: OrgFeedbackRange, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: orgFeedbackReportQueryKeys.report(orgId, range.from, range.to),
    queryFn: async () => {
      const response = await api.get<OrgFeedbackReport>(`/api/organizations/${orgId}/feedback-report`, {
        params: { from: range.from, to: range.to },
      });
      return response.data;
    },
    enabled: options?.enabled ?? false,
  });
}
