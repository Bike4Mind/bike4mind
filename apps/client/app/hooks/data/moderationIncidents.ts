import type { IncidentReviewStatus, IncidentSurface } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const ENDPOINT = '/api/admin/moderation-incidents';
export const MODERATION_INCIDENT_QUEUE_QUERY_KEY = ['admin-moderation-incident-queue'];

// Rows come from lean reads, so the id is `_id`; everything else the page needs is below.
type QueueIncidentJson = {
  _id: string;
  createdAt: string;
  surface?: IncidentSurface;
  reviewStatus?: IncidentReviewStatus;
};

export type ModerationIncidentRow = {
  id: string;
  createdAt: string;
  surface?: IncidentSurface;
  /** A claim left in confirmed_csam after an unknown submission outcome; not resolvable from this page. */
  stuck: boolean;
};

const toRow = (incident: QueueIncidentJson, stuck: boolean): ModerationIncidentRow => ({
  id: String(incident._id),
  createdAt: incident.createdAt,
  surface: incident.surface,
  stuck,
});

/** Unreviewed incidents plus stuck confirmed claims, oldest first. */
export function useModerationIncidentQueue() {
  return useQuery({
    queryKey: MODERATION_INCIDENT_QUEUE_QUERY_KEY,
    queryFn: async () => {
      const { incidents, staleConfirmedCsam } = (
        await api.get<{ incidents: QueueIncidentJson[]; staleConfirmedCsam: QueueIncidentJson[] }>(ENDPOINT, {
          params: { limit: 100 },
        })
      ).data;
      const rows = [...incidents.map(i => toRow(i, false)), ...staleConfirmedCsam.map(i => toRow(i, true))];
      return rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    },
  });
}

export type ModerationIncidentView = {
  id: string;
  createdAt: string;
  surface: IncidentSurface | null;
  reviewStatus: IncidentReviewStatus;
  image:
    | { availability: 'ready'; url: string; expiresAt: string }
    | { availability: 'unavailable'; reason: 'no_stored_image' | 'not_displayable' };
};

/**
 * Every fetch is an audited view with a fresh five-minute image link, so nothing is cached or
 * refetched in the background: a new view happens only when the reviewer opens or reloads one.
 */
export function useModerationIncidentView(id: string) {
  return useQuery({
    queryKey: ['admin-moderation-incident-view', id],
    queryFn: async () => (await api.get<ModerationIncidentView>(`${ENDPOINT}/${encodeURIComponent(id)}/view`)).data,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export type ModerationVerdict = { kind: 'false_positive' } | { kind: 'confirmed'; reportId: string };

export function useModerationIncidentVerdict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, verdict }: { id: string; verdict: ModerationVerdict }) =>
      (
        await api.post<{ ok: true }>(
          `${ENDPOINT}/${encodeURIComponent(id)}/verdict`,
          verdict.kind === 'false_positive'
            ? { verdict: 'false_positive' }
            : { verdict: 'record_manual_report', ncmecReportId: verdict.reportId }
        )
      ).data,
    onSettled: () => queryClient.invalidateQueries({ queryKey: MODERATION_INCIDENT_QUEUE_QUERY_KEY }),
  });
}
