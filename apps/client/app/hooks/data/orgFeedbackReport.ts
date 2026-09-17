import { OrgFeedbackItem, OrgFeedbackItemPage, OrgFeedbackReport } from '@bike4mind/common';
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
  items: (orgId: string, from: string, to: string, subject: string) =>
    ['org-feedback-report', orgId, from, to, 'items', subject] as const,
  item: (orgId: string, feedbackId: string) => ['org-feedback-report', orgId, 'item', feedbackId] as const,
};

/** One page of the drill-down list; the route caps `limit`, so this is not the whole window. */
export const ORG_FEEDBACK_ITEMS_PAGE_SIZE = 25;

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

/**
 * The rows behind one report cell. Same window as the counts by construction - both take the
 * `range` the shell applied, so a cell's number and the list under it cannot disagree about days.
 *
 * Metadata only: the route carries no feedback text, and nothing here asks for any.
 */
export function useOrgFeedbackItems(
  orgId: string,
  range: OrgFeedbackRange,
  subject: string | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: orgFeedbackReportQueryKeys.items(orgId, range.from, range.to, subject ?? ''),
    queryFn: async () => {
      const response = await api.get<OrgFeedbackItemPage>(`/api/organizations/${orgId}/feedback-report/items`, {
        params: { from: range.from, to: range.to, subject: subject ?? undefined, limit: ORG_FEEDBACK_ITEMS_PAGE_SIZE },
      });
      return response.data;
    },
    enabled: (options?.enabled ?? true) && subject !== null,
  });
}

/** One row of the drill-down, opened from the list. Denials are deliberately indistinguishable. */
export function useOrgFeedbackItem(orgId: string, feedbackId: string | null) {
  return useQuery({
    queryKey: orgFeedbackReportQueryKeys.item(orgId, feedbackId ?? ''),
    queryFn: async () => {
      const response = await api.get<OrgFeedbackItem>(`/api/organizations/${orgId}/feedback-report/${feedbackId}`);
      return response.data;
    },
    enabled: feedbackId !== null,
  });
}
