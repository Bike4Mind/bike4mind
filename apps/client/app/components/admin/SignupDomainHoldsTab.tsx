import { useRef, useState } from 'react';
import { Alert, Button, Stack, Switch, Typography } from '@mui/joy';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SIGNUP_DOMAIN_HOLD_REASON_FILTER_KEYS,
  SIGNUP_DOMAIN_HOLD_STATUS_FILTERS,
  type DisposableSourceStatus,
  type SignupDomainHoldAssessment,
  type SignupDomainHoldAutoPolicy,
  type SignupDomainHoldJudgment,
  type SignupDomainHoldReasonFilter,
  type SignupDomainHoldStatusFilter,
  type SignupDomainReview,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import { DataTable } from './shared/DataTable';
import { AdminPageHeader } from './shared/AdminPageHeader';
import { FilterBar } from './shared/FilterBar';
import { ViewTabs } from './shared/ViewTabs';
import { useAdminListUrlState } from './shared/useAdminListUrlState';
import { SIGNUP_DOMAIN_HOLDS_SEARCH_KEYS } from './signupDomainHoldsSearch';

const QUERY_KEY = ['signup-domain-holds'];
const ENDPOINT = '/api/admin/signup-domain-holds';
const PAGE_SIZE = 25;
const STATUS_LABELS: Record<SignupDomainHoldStatusFilter, string> = {
  pending: 'Pending',
  blocked: 'Blocked',
  released: 'Released',
  all: 'All',
};
const REASON_LABELS: Record<SignupDomainHoldReasonFilter, string> = {
  'young-domain': 'Young domain',
  'disposable-aggregate': 'Aggregate disposable list',
  'disposable-list': 'Disposable list',
  'burner-mx': 'Disposable mail provider',
  'signup-burst': 'Signup burst',
};
const EMPTY_LABELS: Record<SignupDomainHoldStatusFilter, string> = {
  pending: 'No holds are waiting for a decision.',
  blocked: 'No confirmed holds in this view.',
  released: 'No released holds in this view.',
  all: 'No signup domains are held.',
};

type HoldsResponse = {
  data: SignupDomainReview[];
  total: number;
  counts: Record<SignupDomainHoldStatusFilter, number>;
  settledVisibleDays: number;
  sources: DisposableSourceStatus[];
  intelCacheSize: number;
};

const isStatusFilter = (value: string): value is SignupDomainHoldStatusFilter =>
  (SIGNUP_DOMAIN_HOLD_STATUS_FILTERS as readonly string[]).includes(value);
const isReasonFilter = (value: string): value is SignupDomainHoldReasonFilter =>
  (SIGNUP_DOMAIN_HOLD_REASON_FILTER_KEYS as readonly string[]).includes(value);
const AUTO_POLICY_LABELS: Record<SignupDomainHoldAutoPolicy, string> = {
  'disposable-aggregate-rule': 'Auto-confirmed by the disposable list rule',
  'advisory-decision': 'Auto-confirmed by the advisory assessment',
};
const JUDGMENT_LABELS: Record<SignupDomainHoldJudgment, string> = {
  abuse: 'abuse',
  legitimate: 'legitimate',
  insufficient_evidence: 'insufficient evidence',
};

const assessmentCaption = (assessment: SignupDomainHoldAssessment): string =>
  assessment.outcome === 'judged'
    ? `Advisory verdict: ${JUDGMENT_LABELS[assessment.judgment]} (${Math.round(assessment.confidence * 100)}% confidence)`
    : `Advisory assessment failed (${assessment.failure.replace(/_/g, ' ')}, attempt ${assessment.attempts})`;

export default function SignupDomainHoldsTab() {
  const [view, updateView] = useAdminListUrlState(SIGNUP_DOMAIN_HOLDS_SEARCH_KEYS);
  const status: SignupDomainHoldStatusFilter = isStatusFilter(view.filters.status) ? view.filters.status : 'pending';
  const reason = isReasonFilter(view.filters.reason) ? view.filters.reason : undefined;
  const includeOlder = view.filters.older === 'true';
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify([status, reason, includeOlder]);
  const [pageKey, setPageKey] = useState(filterKey);
  if (pageKey !== filterKey) {
    setPageKey(filterKey);
    setPage(1);
  }
  const setFilters = (patch: Partial<Record<'status' | 'reason' | 'older', string>>) =>
    updateView({ filters: { ...view.filters, ...patch } });
  const [cursors, setCursors] = useState<Record<string, string | undefined>>({});
  // isPending only flips after a re-render, so a double-click would otherwise send two decisions.
  const decisionInFlight = useRef(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...QUERY_KEY, status, reason, includeOlder, page],
    queryFn: async () =>
      (
        await api.get<HoldsResponse>(ENDPOINT, {
          params: { page, status, ...(reason ? { reason } : {}), includeOlder: String(includeOlder) },
        })
      ).data,
    placeholderData: keepPreviousData,
  });
  const decision = useMutation({
    mutationFn: async (input: { domain: string; action: 'confirm' | 'release'; afterUserId?: string }) =>
      (
        await api.post<{
          status: 'blocked' | 'released';
          creditsReleased: number;
          remaining: number;
          nextCursor: string | null;
        }>(ENDPOINT, input)
      ).data,
    onSuccess: async (result, input) => {
      if (result.status === 'released')
        setCursors(current => ({ ...current, [input.domain]: result.nextCursor ?? undefined }));
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onSettled: () => {
      decisionInFlight.current = false;
    },
  });
  const decide = (input: { domain: string; action: 'confirm' | 'release'; afterUserId?: string }) => {
    if (decisionInFlight.current) return;
    decisionInFlight.current = true;
    decision.mutate(input);
  };
  return (
    <Stack spacing={2} data-testid="signup-domain-holds-tab">
      <AdminPageHeader
        title="Signup domain holds"
        count={query.data?.total}
        description={
          <>
            A hold defers the free signup credits of new accounts from a domain that looks risky: a patterned signup
            burst, a domain only on the aggregate disposable list, a freshly registered domain, or mail run by a
            disposable provider. Confirm and Release only change free signup credits, never the account itself. Confirm
            keeps pending credits held and future signups from the domain get none; it can still be released later.
            Release pays out the held grants and exempts the domain from holds permanently; it cannot be re-blocked.
            Granted balances are never changed. Configure detection in Users settings. Holds from domains only on the
            aggregate disposable list are confirmed automatically on stages that run scheduled jobs unless that is
            turned off in Users settings; each is recorded in the Admin Audit Log as a system action and can still be
            released here. When the advisory assessment is on, a model judges young-domain holds from counts and flags;
            a confident abuse verdict confirms the hold the same way, and any other verdict leaves it for you.
            Young-domain holds are rechecked, and one whose domain has since passed the age threshold is marked so you
            can release it. Nothing automated ever releases a hold. Settled holds older than{' '}
            {query.data?.settledVisibleDays ?? 90} days are hidden, never deleted; turn on Include older to see them.
          </>
        }
      />
      <ViewTabs
        aria-label="Hold status"
        data-testid="signup-domain-holds-status"
        activeId={status}
        onSelect={id => {
          if (isStatusFilter(id)) setFilters({ status: id === 'pending' ? '' : id });
        }}
        views={SIGNUP_DOMAIN_HOLD_STATUS_FILTERS.map(id => ({
          id,
          label: STATUS_LABELS[id],
          count: query.data?.counts[id],
        }))}
      />
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={2}>
        <FilterBar
          search={false}
          state={{ ...view, filters: { reason: reason ?? '' } }}
          onChange={patch => {
            if (patch.filters) setFilters({ reason: patch.filters.reason ?? '' });
          }}
          filters={[
            {
              id: 'reason',
              label: 'Reason',
              options: SIGNUP_DOMAIN_HOLD_REASON_FILTER_KEYS.map(value => ({ value, label: REASON_LABELS[value] })),
            },
          ]}
        />
        <Typography
          component="label"
          level="body-sm"
          startDecorator={
            <Switch
              size="sm"
              checked={includeOlder}
              onChange={event => setFilters({ older: event.target.checked ? 'true' : '' })}
              slotProps={{ input: { 'data-testid': 'signup-domain-holds-include-older-toggle' } }}
            />
          }
        >
          Include older settled holds
        </Typography>
      </Stack>
      {decision.error && <Alert color="danger">{getErrorMessage(decision.error)}</Alert>}
      {decision.data?.status === 'blocked' && (
        <Alert color="success">Domain confirmed; pending credits remain held.</Alert>
      )}
      {decision.data?.status === 'released' && (
        <Alert color="success">
          Released {decision.data.creditsReleased} credits. {decision.data.remaining} pending grants remain; use Retry
          pending grants to continue or retry failures.
        </Alert>
      )}
      <Stack direction="row" spacing={1}>
        <Button
          data-testid="signup-domain-holds-previous"
          disabled={page === 1 || query.isPending}
          onClick={() => setPage(current => current - 1)}
        >
          Previous
        </Button>
        <Button
          data-testid="signup-domain-holds-next"
          disabled={query.isPending || page * PAGE_SIZE >= (query.data?.total ?? 0)}
          onClick={() => setPage(current => current + 1)}
        >
          Next
        </Button>
      </Stack>
      <DataTable<SignupDomainReview>
        rows={query.data?.data ?? []}
        getRowId={review => review.domain}
        label="Signup domain holds"
        loading={query.isPending}
        error={query.error ? getErrorMessage(query.error) : undefined}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        empty={<Typography data-testid="signup-domain-holds-empty">{EMPTY_LABELS[status]}</Typography>}
        columns={[
          {
            id: 'domain',
            label: 'Domain / reason',
            render: review => (
              <>
                {review.domain}
                <Typography level="body-sm">{review.reason}</Typography>
              </>
            ),
          },
          {
            id: 'signups',
            label: 'Signups / samples',
            render: review => (
              <>
                {review.signupCount}
                <Typography level="body-sm">{review.sampleEmails.join(', ')}</Typography>
              </>
            ),
          },
          {
            id: 'status',
            label: 'Status',
            render: review => (
              <>
                {review.status}
                {review.autoDecision && (
                  <Typography level="body-sm" data-testid={`signup-domain-auto-decision-${review.domain}`}>
                    {AUTO_POLICY_LABELS[review.autoDecision.policy]}{' '}
                    {new Date(review.autoDecision.decidedAt).toLocaleString()}
                  </Typography>
                )}
                {review.status === 'held_pending_review' && review.domainAgedAt && (
                  <Typography level="body-sm" color="success" data-testid={`signup-domain-aged-${review.domain}`}>
                    Domain now aged
                    {review.domainRegisteredAt
                      ? ` (registered ${new Date(review.domainRegisteredAt).toLocaleDateString()})`
                      : ''}
                    : past the young-domain threshold. Release if nothing else looks wrong.
                  </Typography>
                )}
                {review.assessment && (
                  <Typography level="body-sm" data-testid={`signup-domain-assessment-${review.domain}`}>
                    {assessmentCaption(review.assessment)}
                  </Typography>
                )}
              </>
            ),
          },
          {
            id: 'review',
            label: 'Review',
            render: review => (
              <Stack direction="row" spacing={1}>
                <Button
                  size="sm"
                  color="danger"
                  data-testid={`signup-domain-confirm-${review.domain}`}
                  disabled={decision.isPending || review.status !== 'held_pending_review'}
                  onClick={() => decide({ domain: review.domain, action: 'confirm' })}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  color={review.status === 'held_pending_review' && review.domainAgedAt ? 'success' : 'primary'}
                  data-testid={`signup-domain-release-${review.domain}`}
                  disabled={decision.isPending}
                  onClick={() =>
                    decide({ domain: review.domain, action: 'release', afterUserId: cursors[review.domain] })
                  }
                >
                  {review.status === 'released' ? 'Retry pending grants' : 'Release'}
                </Button>
              </Stack>
            ),
          },
        ]}
      />
      <Typography level="title-md">Disposable list sources</Typography>
      <DataTable<DisposableSourceStatus>
        rows={query.data?.sources ?? []}
        getRowId={source => source.source}
        label="Disposable list sources"
        testId="signup-domain-holds-sources"
        loading={query.isPending}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        empty={<Typography>The disposable list refresh has not run yet.</Typography>}
        columns={[
          { id: 'source', label: 'Source', render: source => source.source },
          { id: 'count', label: 'Domains', numeric: true, render: source => source.count },
          {
            id: 'lastSuccess',
            label: 'Last success',
            render: source => (source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString() : 'never'),
          },
          {
            id: 'lastError',
            label: 'Last error',
            render: source =>
              source.lastError
                ? `${source.lastError}${source.lastErrorAt ? ` (${new Date(source.lastErrorAt).toLocaleString()})` : ''}`
                : '-',
          },
        ]}
      />
      {query.data && <Typography level="body-sm">Cached domain lookups: {query.data.intelCacheSize}</Typography>}
    </Stack>
  );
}
