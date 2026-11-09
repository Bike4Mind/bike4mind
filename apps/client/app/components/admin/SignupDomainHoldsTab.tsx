import { useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dropdown,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/joy';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { MoreHorizontal } from 'lucide-react';
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
import { PENDING_GRANTS_QUERY_KEY } from '@client/app/hooks/data/adminSignupGrant';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  DataTable,
  EmptyState,
  FilterBar,
  StatusChip,
  ViewTabs,
  useAdminListUrlState,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
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
const HOLD_STATUS_CHIPS: Record<SignupDomainReview['status'], { label: string; tone: AdminStatusTone }> = {
  held_pending_review: { label: 'Pending review', tone: 'warn' },
  blocked: { label: 'Blocked', tone: 'bad' },
  released: { label: 'Released', tone: 'good' },
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
  const total = query.data?.total;
  if (!query.isPlaceholderData && total !== undefined && page > 1 && (page - 1) * PAGE_SIZE >= total)
    setPage(Math.max(1, Math.ceil(total / PAGE_SIZE)));
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
    onSuccess: (result, input) => {
      if (result.status === 'released')
        setCursors(current => ({ ...current, [input.domain]: result.nextCursor ?? undefined }));
    },
    onSettled: async (_result, _error, input) => {
      decisionInFlight.current = false;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
        ...(input.action === 'release' ? [queryClient.invalidateQueries({ queryKey: PENDING_GRANTS_QUERY_KEY })] : []),
      ]);
    },
  });
  // A failure shows in the Alert below (decision.error), so the promise never rejects.
  const decide = async (input: { domain: string; action: 'confirm' | 'release'; afterUserId?: string }) => {
    if (decisionInFlight.current) return;
    decisionInFlight.current = true;
    try {
      await decision.mutateAsync(input);
    } catch {
      /* reported through decision.error */
    }
  };
  const release = (review: SignupDomainReview) =>
    decide({ domain: review.domain, action: 'release', afterUserId: cursors[review.domain] });
  // Release and Confirm change what free credits pay out, so they ask first; Retry re-posts a decided release.
  const [reviewing, setReviewing] = useState<{ review: SignupDomainReview; action: 'confirm' | 'release' } | null>(
    null
  );
  const openAll = !reason && status === 'all';
  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="signup-domain-holds-tab">
      <AdminPageHeader
        title="Signup domain holds"
        count={query.data?.total}
        description={
          <>
            Free signup credits held from domains that look risky. Confirm keeps them held; Release pays them out.
            <Tooltip
              variant="outlined"
              placement="bottom-start"
              sx={{ maxWidth: 480 }}
              title={
                <Typography level="body-sm" component="div">
                  A hold defers the free signup credits of new accounts from a domain that looks risky: a patterned
                  signup burst, a domain only on the aggregate disposable list, a freshly registered domain, or mail run
                  by a disposable provider. Confirm and Release only change free signup credits, never the account
                  itself. Confirm keeps pending credits held and future signups from the domain get none; it can still
                  be released later. Release pays out the held grants and exempts the domain from holds permanently; it
                  cannot be re-blocked. Granted balances are never changed. Configure detection in Users settings. Holds
                  from domains only on the aggregate disposable list are confirmed automatically on stages that run
                  scheduled jobs unless that is turned off in Users settings; each is recorded in the Admin Audit Log as
                  a system action and can still be released here. When the advisory assessment is on, a model judges
                  young-domain holds from counts and flags; a confident abuse verdict confirms the hold the same way,
                  and any other verdict leaves it for you. Young-domain holds are rechecked, and one whose domain has
                  since passed the age threshold is marked so you can release it. Nothing automated ever releases a
                  hold. Settled holds older than {query.data?.settledVisibleDays ?? 90} days are hidden, never deleted;
                  turn on Include older to see them.
                </Typography>
              }
            >
              <IconButton
                size="sm"
                variant="plain"
                aria-label="About signup domain holds"
                data-testid="signup-domain-holds-help-btn"
                sx={{ '--IconButton-size': '24px', ml: 0.5, verticalAlign: 'middle' }}
              >
                <HelpOutlineIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
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
          Released {decision.data.creditsReleased} credits. {decision.data.remaining} pending grants remain; switch the
          status filter to Released and use Retry pending grants to continue or retry failures.
        </Alert>
      )}
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
        testId="signup-domain-holds-table"
        minWidth="56rem"
        empty={
          <Box data-testid="signup-domain-holds-empty">
            <EmptyState
              title={EMPTY_LABELS[status]}
              action={
                openAll ? (
                  !includeOlder && (
                    <Button
                      size="sm"
                      variant="outlined"
                      color="neutral"
                      onClick={() => setFilters({ older: 'true' })}
                      data-testid="signup-domain-holds-empty-action"
                    >
                      Include older settled holds
                    </Button>
                  )
                ) : (
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    onClick={() => setFilters({ status: 'all', reason: '' })}
                    data-testid="signup-domain-holds-empty-action"
                  >
                    Show all holds
                  </Button>
                )
              }
            />
          </Box>
        }
        rowActions={review => (
          <Dropdown>
            <MenuButton
              slots={{ root: IconButton }}
              slotProps={{ root: { variant: 'plain', size: 'sm', 'aria-label': `Actions for ${review.domain}` } }}
              data-testid={`signup-domain-actions-${review.domain}`}
            >
              <MoreHorizontal size={16} />
            </MenuButton>
            <Menu placement="bottom-end">
              {review.status === 'released' ? (
                <MenuItem
                  disabled={decision.isPending}
                  data-testid={`signup-domain-release-${review.domain}`}
                  onClick={() => void release(review)}
                >
                  Retry pending grants
                </MenuItem>
              ) : (
                <MenuItem
                  disabled={decision.isPending}
                  data-testid={`signup-domain-release-${review.domain}`}
                  onClick={() => setReviewing({ review, action: 'release' })}
                >
                  Release hold
                </MenuItem>
              )}
              <MenuItem
                color="danger"
                disabled={decision.isPending || review.status !== 'held_pending_review'}
                data-testid={`signup-domain-confirm-${review.domain}`}
                onClick={() => setReviewing({ review, action: 'confirm' })}
              >
                <div>
                  Confirm hold
                  {review.status !== 'held_pending_review' && (
                    <Typography level="body-xs" data-testid={`signup-domain-confirm-hint-${review.domain}`}>
                      Only pending holds can be confirmed
                    </Typography>
                  )}
                </div>
              </MenuItem>
            </Menu>
          </Dropdown>
        )}
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
                <StatusChip
                  tone={HOLD_STATUS_CHIPS[review.status].tone}
                  label={HOLD_STATUS_CHIPS[review.status].label}
                />
                {review.autoDecision && (
                  <Typography level="body-sm" data-testid={`signup-domain-auto-decision-${review.domain}`}>
                    {AUTO_POLICY_LABELS[review.autoDecision.policy]}{' '}
                    {new Date(review.autoDecision.decidedAt).toLocaleString()}
                  </Typography>
                )}
                {review.status === 'held_pending_review' && review.domainAgedAt && (
                  <Stack gap={0.5} sx={{ mt: 0.5 }} data-testid={`signup-domain-aged-${review.domain}`}>
                    <Box>
                      <StatusChip tone="good" label="Domain now aged" />
                    </Box>
                    <Typography level="body-sm">
                      Past the young-domain threshold
                      {review.domainRegisteredAt
                        ? ` (registered ${new Date(review.domainRegisteredAt).toLocaleDateString()})`
                        : ''}
                      . Release if nothing else looks wrong.
                    </Typography>
                  </Stack>
                )}
                {review.assessment && (
                  <Typography level="body-sm" data-testid={`signup-domain-assessment-${review.domain}`}>
                    {assessmentCaption(review.assessment)}
                  </Typography>
                )}
              </>
            ),
          },
        ]}
      />
      <Stack direction="row" gap={1} justifyContent="flex-end">
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          data-testid="signup-domain-holds-previous"
          disabled={page === 1 || query.isPending}
          onClick={() => setPage(current => current - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          data-testid="signup-domain-holds-next"
          disabled={query.isPending || page * PAGE_SIZE >= (query.data?.total ?? 0)}
          onClick={() => setPage(current => current + 1)}
        >
          Next
        </Button>
      </Stack>
      <AdminPageHeader level="section" title="Disposable list sources" />
      <DataTable<DisposableSourceStatus>
        rows={query.data?.sources ?? []}
        getRowId={source => source.source}
        label="Disposable list sources"
        testId="signup-domain-holds-sources"
        loading={query.isPending}
        error={query.error ? getErrorMessage(query.error) : undefined}
        onRetry={() => {
          void query.refetch();
        }}
        pagination={false}
        empty={
          <EmptyState
            title="The disposable list refresh has not run yet"
            action={
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => void query.refetch()}
                data-testid="signup-domain-holds-sources-retry-btn"
              >
                Retry
              </Button>
            }
          />
        }
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
      <ActionDialog
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        title={reviewing?.action === 'confirm' ? 'Confirm hold' : 'Release hold'}
        tone={reviewing?.action === 'confirm' ? 'danger' : 'neutral'}
        description={
          reviewing?.action === 'confirm' ? (
            <>
              Keep the pending signup credits for <b>{reviewing.review.domain}</b> held and give future signups from the
              domain none. It can still be released later.
            </>
          ) : (
            <>
              Pay out the held signup credits for <b>{reviewing?.review.domain}</b> and exempt the domain from holds
              permanently. It cannot be re-blocked.
            </>
          )
        }
        reasonPresets={
          reviewing?.action === 'confirm'
            ? ADMIN_REASON_PRESETS.signupDomainHoldConfirm
            : ADMIN_REASON_PRESETS.signupDomainHoldRelease
        }
        reasonAudited={false}
        confirmLabel={reviewing?.action === 'confirm' ? 'Confirm hold' : 'Release hold'}
        onConfirm={async () => {
          if (!reviewing) return;
          const { review, action } = reviewing;
          setReviewing(null);
          await (action === 'release' ? release(review) : decide({ domain: review.domain, action }));
        }}
        data-testid="signup-domain-decision-dialog"
      />
    </Stack>
  );
}
