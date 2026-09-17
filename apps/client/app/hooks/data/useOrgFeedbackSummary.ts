import { IOrgFeedbackSummaryProgressAction, OrgFeedbackSummaryView } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import type { OrgFeedbackRange } from '@client/app/hooks/data/orgFeedbackReport';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/** The window the report panel shows as whole days, widened to the instants the job is keyed on. */
export const summaryWindow = (range: OrgFeedbackRange) => ({
  startDate: new Date(`${range.from}T00:00:00.000Z`).toISOString(),
  endDate: new Date(`${range.to}T23:59:59.999Z`).toISOString(),
});

export const orgFeedbackSummaryQueryKeys = {
  summary: (orgId: string, startDate: string, endDate: string) =>
    ['org-feedback-summary', orgId, startDate, endDate] as const,
};

/**
 * The LLM summary for one window: what exists now, plus the button that asks for one.
 *
 * The worker owns the job, so this hook does not poll it. The completion frame arrives over the
 * websocket and only invalidates the query - the route is what re-reads the artifact, because it
 * is also what re-checks the org gate.
 */
export function useOrgFeedbackSummary(orgId: string, range: OrgFeedbackRange) {
  const queryClient = useQueryClient();
  const { subscribeToAction } = useWebsocket();
  const { startDate, endDate } = summaryWindow(range);
  const queryKey = orgFeedbackSummaryQueryKeys.summary(orgId, startDate, endDate);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await api.get<OrgFeedbackSummaryView>(`/api/organizations/${orgId}/feedback-summary`, {
        params: { startDate, endDate },
      });
      return response.data;
    },
  });

  const generate = useMutation({
    mutationFn: async () => {
      const response = await api.post<{ summaryJobId: string; reused: boolean }>(
        `/api/organizations/${orgId}/feedback-summary`,
        { startDate, endDate }
      );
      return response.data;
    },
    // Re-read rather than write the status in by hand: a reused job may already be further along
    // than 'pending', and the route is the only thing that knows.
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  useEffect(() => {
    const unsubscribe = subscribeToAction('org_feedback_summary_progress', async message => {
      const msg = message as IOrgFeedbackSummaryProgressAction;
      if (msg.organizationId !== orgId) return;
      await queryClient.invalidateQueries({ queryKey });
    });
    return unsubscribe;

    // is a new reference every render; its contents are the real dependency.
  }, [orgId, startDate, endDate, subscribeToAction, queryClient]);

  return { ...query, generate };
}
