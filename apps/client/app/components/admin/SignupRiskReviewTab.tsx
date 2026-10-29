import React, { useMemo, useState } from 'react';
import { Alert, Button, Dropdown, IconButton, Menu, MenuButton, MenuItem, Stack, Tooltip, Typography } from '@mui/joy';
import { MoreHorizontal } from 'lucide-react';
import {
  ADMIN_ACTION_REASON_MAX_LENGTH,
  MAX_SIGNUP_RISK_REVIEW_BATCH,
  SIGNUP_RISK_REVIEW_LIST_LIMIT,
  SIGNUP_RISK_SIGNALS,
  type SignupRiskSignal,
} from '@bike4mind/common';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  BulkActionBar,
  DataTable,
  EmptyState,
  FilterBar,
  StatusChip,
  relativeTime,
  useAdminListUrlState,
  useUndoToast,
  type AdminSelection,
  type DataColumn,
} from './shared';
import { SIGNUP_RISK_REVIEW_SEARCH_KEYS } from './signupRiskReviewSearch';
import BulkAbuseResponseModal from './Users/BulkAbuseResponseModal';
import { useOpenUserProfile } from './Users/Profile/useOpenUserProfile';
import {
  useSignupRiskReviewDecision,
  useSignupRiskReviews,
  type SignupRiskReviewRow,
} from '@client/app/hooks/data/signupRiskReviews';
import { getErrorMessage } from '@client/app/utils/error';

export const SIGNAL_LABELS: Record<SignupRiskSignal, string> = {
  riskyDomain: 'Risky domain',
  burstCohort: 'Signup burst',
  datacenterNetwork: 'Datacenter network',
  quickApiKey: 'Quick API key',
  fastSpend: 'Fast spend',
  generatedLocalPart: 'Generated address',
};

// Every row is at or above the review threshold, so the split is only between "look" and "look first":
// the midpoint between the threshold and the maximum score (75 at the default threshold of 50).
const highRiskScore = (reviewThreshold: number) => reviewThreshold + (100 - reviewThreshold) / 2;

// Domain filter options: the largest cohorts, so a burst is one pick away.
const DOMAIN_FILTER_OPTIONS = 20;

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

const SignupTime: React.FC<{ iso: string; now: number }> = ({ iso, now }) => {
  const date = new Date(iso);
  return (
    <Tooltip title={date.toISOString()}>
      <Typography component="time" dateTime={date.toISOString()} tabIndex={0} level="body-sm" noWrap>
        {relativeTime(date, now)}
      </Typography>
    </Tooltip>
  );
};

const Signals: React.FC<{ row: SignupRiskReviewRow }> = ({ row }) => (
  <Stack direction="row" flexWrap="wrap" gap={0.5}>
    {row.signals.map(signal => (
      <Tooltip key={signal.signal} title={`${signal.reason} (+${signal.points})`}>
        <span tabIndex={0} data-testid={`signup-risk-signal-${row.userId}-${signal.signal}`}>
          <StatusChip tone="neutral" label={SIGNAL_LABELS[signal.signal]} />
        </span>
      </Tooltip>
    ))}
  </Stack>
);

const ApprovalPreview: React.FC<{ rows: SignupRiskReviewRow[] }> = ({ rows }) => (
  <Stack gap={0.5} data-testid="signup-risk-approve-preview">
    {rows.slice(0, 5).map(row => (
      <Typography key={row.userId} level="body-sm">
        {row.email ?? row.username ?? row.userId} - score {row.score}
      </Typography>
    ))}
    {rows.length > 5 && (
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        and {plural(rows.length - 5, 'more account')}
      </Typography>
    )}
  </Stack>
);

/**
 * Accounts whose signup risk score reached the review threshold (User.riskScore, scored by
 * refreshSignupRiskScore). Approve settles a review for good; suspending reuses the bulk abuse
 * response dialog, which bans, revokes keys and sessions and can claw back the signup grant.
 */
export const SignupRiskReviewTab: React.FC = () => {
  const reviews = useSignupRiskReviews();
  const decision = useSignupRiskReviewDecision();
  const showUndo = useUndoToast();
  const openProfile = useOpenUserProfile();
  const [view, updateView] = useAdminListUrlState(SIGNUP_RISK_REVIEW_SEARCH_KEYS);
  // Searches emails, so it stays out of the URL; only the domain and signal filters are shareable.
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<AdminSelection>({ mode: 'explicit', ids: [] });
  const [approving, setApproving] = useState<SignupRiskReviewRow[] | null>(null);
  const [suspending, setSuspending] = useState<string[] | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [now] = useState(() => Date.now());

  const highRisk = highRiskScore(reviews.data?.reviewThreshold ?? 50);
  const rows = useMemo(() => reviews.data?.data ?? [], [reviews.data]);
  const domainOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) if (row.domain) counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, DOMAIN_FILTER_OPTIONS)
      .map(([domain, count]) => ({ value: domain, label: `${domain} (${count.toLocaleString()})` }));
  }, [rows]);

  const needle = query.trim().toLowerCase();
  const visibleRows = rows.filter(
    row =>
      (!needle || [row.email, row.username, row.domain].some(value => value?.toLowerCase().includes(needle))) &&
      (!view.filters.domain || row.domain === view.filters.domain) &&
      (!view.filters.signal || row.signals.some(signal => signal.signal === view.filters.signal))
  );
  const filterKey = JSON.stringify([needle, view.filters]);
  const [selectionKey, setSelectionKey] = useState(filterKey);
  if (selectionKey !== filterKey) {
    setSelectionKey(filterKey);
    setSelection({ mode: 'explicit', ids: [] });
  }
  const selectedRows =
    selection.mode === 'allMatching' ? visibleRows : visibleRows.filter(row => selection.ids.includes(row.userId));
  const clearSelection = () => setSelection({ mode: 'explicit', ids: [] });

  const approve = (targets: SignupRiskReviewRow[], reason: string) =>
    decision.mutate(
      { action: 'approve', userIds: targets.map(row => row.userId), reason },
      {
        onSuccess: result => {
          setApproving(null);
          clearSelection();
          const approved = result.updatedUserIds;
          setFailedCount(result.failedUserIds.length);
          if (approved.length === 0) return;
          showUndo({
            message: `Approved ${plural(approved.length, 'account')}`,
            onUndo: async () => {
              await decision.mutateAsync({
                action: 'reopen',
                userIds: approved,
                reason: `Undid approval: ${reason}`.slice(0, ADMIN_ACTION_REASON_MAX_LENGTH),
              });
            },
          });
        },
      }
    );

  const columns: readonly DataColumn<SignupRiskReviewRow>[] = [
    {
      id: 'account',
      label: 'Account',
      render: row => {
        const primary = row.email ?? row.username ?? row.userId;
        // Signups default the username to the email's local part; only a different one adds information.
        const showUsername = row.email && row.username && row.username !== row.email.split('@')[0];
        return (
          <Tooltip title={showUsername ? `${primary} (${row.username})` : primary}>
            <Stack tabIndex={0} sx={{ minWidth: 0 }}>
              <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
                {primary}
              </Typography>
              {showUsername && (
                <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
                  {row.username}
                </Typography>
              )}
            </Stack>
          </Tooltip>
        );
      },
      sortValue: row => row.email ?? row.username ?? row.userId,
    },
    {
      id: 'domain',
      label: 'Domain',
      render: row =>
        row.domain ? (
          <Typography level="body-sm" noWrap title={row.domain} sx={{ color: 'admin.ink' }}>
            {row.domain}
          </Typography>
        ) : (
          <Typography sx={{ color: 'admin.inkMuted' }}>-</Typography>
        ),
      sortValue: row => row.domain ?? '',
    },
    {
      id: 'score',
      label: 'Risk score',
      render: row => (
        <Stack direction="row" gap={1} justifyContent="flex-end" alignItems="center">
          <StatusChip
            tone={row.score >= highRisk ? 'bad' : 'warn'}
            label={row.score >= highRisk ? 'High risk' : 'Medium risk'}
          />
          {row.score}
        </Stack>
      ),
      sortValue: row => row.score,
      numeric: true,
      width: '8.5rem',
    },
    { id: 'signals', label: 'Signals', render: row => <Signals row={row} /> },
    {
      id: 'createdAt',
      label: 'Signed up',
      render: row => <SignupTime iso={row.createdAt} now={now} />,
      sortValue: row => row.createdAt,
      width: '8rem',
    },
    {
      id: 'creditsSpent',
      label: 'Credits spent',
      render: row => row.creditsSpent.toLocaleString(),
      sortValue: row => row.creditsSpent,
      numeric: true,
      width: '8.5rem',
    },
    {
      id: 'apiKeysCreated',
      label: 'API keys',
      render: row => row.apiKeysCreated.toLocaleString(),
      sortValue: row => row.apiKeysCreated,
      numeric: true,
      width: '7rem',
    },
  ];

  const rowActions = (row: SignupRiskReviewRow) => (
    <Dropdown>
      <MenuButton
        slots={{ root: IconButton }}
        slotProps={{
          root: { variant: 'plain', size: 'sm', 'aria-label': `Actions for ${row.email ?? row.userId}` },
        }}
        data-testid={`signup-risk-actions-${row.userId}`}
      >
        <MoreHorizontal size={16} />
      </MenuButton>
      <Menu placement="bottom-end">
        <MenuItem data-testid={`signup-risk-approve-${row.userId}`} onClick={() => setApproving([row])}>
          Approve account
        </MenuItem>
        <MenuItem
          color="danger"
          data-testid={`signup-risk-suspend-${row.userId}`}
          onClick={() => setSuspending([row.userId])}
        >
          Suspend account
        </MenuItem>
      </Menu>
    </Dropdown>
  );

  const filtered = needle !== '' || Object.values(view.filters).some(Boolean);

  return (
    <Stack
      spacing={2}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', p: 2, borderRadius: 'md' }}
      data-testid="admin-signup-risk-review-tab"
    >
      <AdminPageHeader
        title="Risk review"
        count={rows.length}
        description="New accounts whose signup risk score reached the review threshold, highest first. Approve the ones that look legitimate; later rescores never flag them again. Suspend the rest."
      />
      {reviews.data?.truncated && (
        <Alert color="warning" data-testid="signup-risk-truncated">
          Showing the {SIGNUP_RISK_REVIEW_LIST_LIMIT.toLocaleString()} highest scores. Decide these to see the rest.
        </Alert>
      )}
      {failedCount > 0 && (
        <Alert color="warning" data-testid="signup-risk-failed">
          {plural(failedCount, 'account')} could not be approved and {failedCount === 1 ? 'was' : 'were'} left in the
          queue. Try again.
        </Alert>
      )}
      {decision.error && !approving && (
        <Alert color="danger" data-testid="signup-risk-decision-error">
          {getErrorMessage(decision.error)}
        </Alert>
      )}
      <FilterBar
        state={{ ...view, query }}
        onChange={patch => {
          if (patch.query !== undefined) setQuery(patch.query);
          if (patch.filters) updateView({ filters: patch.filters, view: '' });
        }}
        searchLabel="Search email or domain"
        filters={[
          { id: 'domain', label: 'Domain', options: domainOptions },
          {
            id: 'signal',
            label: 'Signal',
            options: SIGNUP_RISK_SIGNALS.map(signal => ({ value: signal, label: SIGNAL_LABELS[signal] })),
          },
        ]}
      />
      <DataTable
        rows={visibleRows}
        columns={columns}
        label="Accounts waiting for review"
        getRowId={row => row.userId}
        pageResetKey={filterKey}
        testId="signup-risk-review-table"
        rowTestId={row => `signup-risk-row-${row.userId}`}
        loading={reviews.isPending}
        error={reviews.error ? "Couldn't load the review queue." : undefined}
        onRetry={() => void reviews.refetch()}
        onRowActivate={row => void openProfile(row.userId)}
        rowActions={rowActions}
        // The fixed-width columns plus room for account, domain and signals; narrower screens scroll sideways.
        minWidth="72rem"
        selection={selection}
        onSelectionChange={setSelection}
        empty={
          <EmptyState
            title={filtered ? 'No matching accounts' : 'No accounts are waiting for review'}
            description={
              filtered
                ? undefined
                : 'Accounts are scored at signup, email verification and API key creation, and land here once they reach the review threshold.'
            }
            action={
              <Button
                variant="outlined"
                data-testid="signup-risk-reset-btn"
                onClick={() => {
                  if (filtered) {
                    setQuery('');
                    updateView({ filters: {}, view: '' });
                  } else void reviews.refetch();
                }}
              >
                {filtered ? 'Clear filters' : 'Refresh queue'}
              </Button>
            }
          />
        }
      />
      <BulkActionBar
        selection={selection}
        totalMatching={visibleRows.length}
        onSelectAllMatching={() => setSelection({ mode: 'allMatching' })}
        onClear={clearSelection}
      >
        <Button
          variant="outlined"
          data-testid="signup-risk-bulk-approve-btn"
          disabled={selectedRows.length === 0}
          onClick={() => setApproving(selectedRows)}
        >
          Approve accounts
        </Button>
        <Button
          variant="outlined"
          color="danger"
          data-testid="signup-risk-bulk-suspend-btn"
          disabled={selectedRows.length === 0}
          onClick={() => setSuspending(selectedRows.map(row => row.userId))}
        >
          Suspend accounts
        </Button>
      </BulkActionBar>

      <ActionDialog
        open={approving !== null}
        onClose={() => {
          if (!decision.isPending) setApproving(null);
        }}
        title={approving && approving.length > 1 ? `Approve ${plural(approving.length, 'account')}` : 'Approve account'}
        description="They leave this queue, and later rescores keep the approval. Undo is offered for 30 seconds."
        reasonPresets={ADMIN_REASON_PRESETS.signupRiskApproval}
        confirmLabel={
          approving && approving.length > 1 ? `Approve ${plural(approving.length, 'account')}` : 'Approve account'
        }
        blockedReason={
          approving && approving.length > MAX_SIGNUP_RISK_REVIEW_BATCH
            ? `Select at most ${MAX_SIGNUP_RISK_REVIEW_BATCH} accounts to approve at once.`
            : null
        }
        pending={decision.isPending}
        onConfirm={reason => {
          if (approving) approve(approving, reason);
        }}
        data-testid="signup-risk-approve-dialog"
        testIds={{ confirm: 'signup-risk-approve-confirm-btn', reason: 'signup-risk-approve-reason' }}
      >
        {approving && <ApprovalPreview rows={approving} />}
        {decision.error && <Alert color="danger">{getErrorMessage(decision.error)}</Alert>}
      </ActionDialog>

      {suspending && (
        <BulkAbuseResponseModal
          selectedUserIds={suspending}
          onClose={() => setSuspending(null)}
          onExecuted={() => {
            clearSelection();
            void reviews.refetch();
          }}
        />
      )}
    </Stack>
  );
};

export default SignupRiskReviewTab;
