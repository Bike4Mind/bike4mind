import type {
  IncidentEscalationTrigger,
  IncidentOverridableReviewStatus,
  IncidentReviewStatus,
  IncidentSurface,
  ModerationLabelHit,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const ENDPOINT = '/api/admin/moderation-incidents';
export const MODERATION_INCIDENT_QUEUE_QUERY_KEY = ['admin-moderation-incident-queue'];
export const MODERATION_INCIDENT_SUMMARY_QUERY_KEY = ['admin-moderation-incident-summary'];

// A verdict or an escalation changes both the queue and its counts.
const invalidateReviewPage = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: MODERATION_INCIDENT_QUEUE_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: MODERATION_INCIDENT_SUMMARY_QUERY_KEY }),
  ]);

const QUEUE_LIST_LIMIT = 100;

// Rows come from lean reads, so the id is `_id`; everything else the page needs is below.
type QueueIncidentJson = {
  _id: string;
  createdAt: string;
  userId: string;
  userEmail: string | null;
  labels?: ModerationLabelHit[];
  surface?: IncidentSurface;
  reviewStatus?: IncidentReviewStatus;
  escalatedAt?: string;
};

export type ModerationIncidentRow = {
  id: string;
  createdAt: string;
  userId: string;
  userEmail: string | null;
  /** The highest-confidence label, when the incident has any. */
  topLabel: ModerationLabelHit | null;
  surface?: IncidentSurface;
  reviewStatus: IncidentReviewStatus;
  /** A claim left in confirmed_csam after an unknown submission outcome; not resolvable from this page. */
  stuck: boolean;
  /** Moved to the second review step, by a reviewer or after waiting too long. */
  escalated: boolean;
};

/** `open` is the work queue; `closed` lists past verdicts, newest first. */
export type ModerationIncidentQueueStatus = 'open' | 'closed';

export const topLabel = (labels: readonly ModerationLabelHit[] | undefined): ModerationLabelHit | null =>
  (labels ?? []).reduce<ModerationLabelHit | null>(
    (top, label) => (top === null || label.confidence > top.confidence ? label : top),
    null
  );

const toRow = (incident: QueueIncidentJson, stuck: boolean): ModerationIncidentRow => ({
  id: String(incident._id),
  createdAt: incident.createdAt,
  userId: incident.userId,
  userEmail: incident.userEmail,
  topLabel: topLabel(incident.labels),
  surface: incident.surface,
  reviewStatus: incident.reviewStatus ?? 'pending_review',
  stuck,
  escalated: Boolean(incident.escalatedAt),
});

const createdAtMs = (row: ModerationIncidentRow) => new Date(row.createdAt).getTime();

/** Position in the closed list: the last row's createdAt (ISO) and id; pages continue after it. */
export type ClosedCursor = { before: string; beforeId: string };

/**
 * Open: unreviewed incidents plus stuck confirmed claims, oldest first. Closed: past verdicts, newest
 * first; `closedCursor` pages back to the ones after that row.
 */
export function useModerationIncidentQueue(
  status: ModerationIncidentQueueStatus = 'open',
  closedCursor?: ClosedCursor
) {
  const cursor = status === 'closed' ? closedCursor : undefined;
  return useQuery({
    queryKey: [...MODERATION_INCIDENT_QUEUE_QUERY_KEY, status, cursor?.before ?? null, cursor?.beforeId ?? null],
    queryFn: async () => {
      const { incidents, staleConfirmedCsam, hasMore } = (
        await api.get<{ incidents: QueueIncidentJson[]; staleConfirmedCsam: QueueIncidentJson[]; hasMore?: boolean }>(
          ENDPOINT,
          { params: { limit: QUEUE_LIST_LIMIT, status, ...(cursor ?? {}) } }
        )
      ).data;
      const rows = [...incidents.map(i => toRow(i, false)), ...staleConfirmedCsam.map(i => toRow(i, true))];
      rows.sort((a, b) => (status === 'closed' ? createdAtMs(b) - createdAtMs(a) : createdAtMs(a) - createdAtMs(b)));
      // The open lists are capped by the route, so a full one means more are waiting; closed says so itself.
      const truncated =
        status === 'closed'
          ? hasMore === true
          : incidents.length >= QUEUE_LIST_LIMIT || staleConfirmedCsam.length >= QUEUE_LIST_LIMIT;
      return { rows, truncated };
    },
  });
}

/** Counts for the review page; no incident, user or address. */
export type ModerationIncidentSummary = {
  /** Unreviewed incidents. */
  needsReview: number;
  /** Of needsReview, the ones held by the second review step. */
  escalated: number;
  /** Report submissions left in an unknown state. */
  stuck: number;
  closed: { noAction: number; falsePositive: number; reported: number };
  oldestPendingCreatedAt: string | null;
  /** Whether each reviewer list has at least one valid address. */
  reviewersConfigured: boolean;
  escalationReviewersConfigured: boolean;
};

export function useModerationIncidentSummary() {
  return useQuery({
    queryKey: MODERATION_INCIDENT_SUMMARY_QUERY_KEY,
    queryFn: async () => (await api.get<ModerationIncidentSummary>(`${ENDPOINT}/summary`)).data,
  });
}

export type ModerationIncidentView = {
  id: string;
  createdAt: string;
  surface: IncidentSurface | null;
  reviewStatus: IncidentReviewStatus;
  /** The verdict a recorded report overrode, if any. */
  previousReviewStatus: IncidentOverridableReviewStatus | null;
  /** The flagged account; email is null when the account no longer exists. */
  user: { id: string; email: string | null };
  /** Classifier labels; confidence is a percentage (0-100). */
  labels: ModerationLabelHit[];
  provider: string;
  model: string;
  sessionId: string | null;
  questId: string | null;
  fabFileId: string | null;
  ncmecReportId: string | null;
  /** Null when no reviewer alert was delivered. */
  alertedAt: string | null;
  /** Set when the alert was queued for delivery; until alertedAt is set too, it is still in flight. */
  alertQueuedAt: string | null;
  /** When a reviewer's copy last failed; at or after alertQueuedAt, that round awaits a resend. */
  alertFailedAt: string | null;
  lastReminderAt: string | null;
  /** Null until the incident moves to the second review step. */
  escalatedAt: string | null;
  escalationTrigger: IncidentEscalationTrigger | null;
  /** Null when no escalation email was delivered. */
  escalationAlertedAt: string | null;
  /** Same as alertQueuedAt, for the escalation email. */
  escalationAlertQueuedAt: string | null;
  /** Same as alertFailedAt, for the escalation email. */
  escalationAlertFailedAt: string | null;
  reportedAt: string | null;
  falsePositiveAt: string | null;
  noActionAt: string | null;
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

export type ModerationVerdict =
  { kind: 'no_action' } | { kind: 'false_positive' } | { kind: 'confirmed'; reportId: string };

const verdictBody = (verdict: ModerationVerdict) => {
  switch (verdict.kind) {
    case 'no_action':
      return { verdict: 'no_action' };
    case 'false_positive':
      return { verdict: 'false_positive' };
    case 'confirmed':
      return { verdict: 'record_manual_report', ncmecReportId: verdict.reportId };
  }
};

// Both writes need a recently verified session: the api client's step-up interceptor prompts for it
// and replays the request, as it does for the view.
export function useModerationIncidentVerdict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, verdict, reason }: { id: string; verdict: ModerationVerdict; reason: string }) =>
      (
        await api.post<{ ok: true }>(`${ENDPOINT}/${encodeURIComponent(id)}/verdict`, {
          ...verdictBody(verdict),
          reason,
        })
      ).data,
    onSettled: () => invalidateReviewPage(queryClient),
  });
}

/**
 * Whether the escalation email went out: `queued` means it is waiting on the email-send worker,
 * `no_recipients` means no escalation reviewer is configured.
 */
export type ModerationEscalationAlert = 'delivered' | 'queued' | 'no_recipients' | 'failed';

export type ModerationEscalationResult = {
  incident: Pick<
    ModerationIncidentView,
    'id' | 'reviewStatus' | 'escalatedAt' | 'escalationTrigger' | 'escalationAlertedAt' | 'escalationAlertQueuedAt'
  >;
  alert: ModerationEscalationAlert;
};

export function useModerationIncidentEscalation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await api.post<ModerationEscalationResult>(`${ENDPOINT}/${encodeURIComponent(id)}/escalate`, { reason })).data,
    onSettled: () => invalidateReviewPage(queryClient),
  });
}
