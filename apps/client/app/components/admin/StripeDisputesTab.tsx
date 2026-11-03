import React, { useState } from 'react';
import { Alert, Button, Stack, Tooltip, Typography } from '@mui/joy';
import { Link } from '@tanstack/react-router';
import {
  STRIPE_DISPUTE_LIST_LIMIT,
  STRIPE_DISPUTE_STATES,
  STRIPE_DISPUTE_SUBJECTS,
  isStripeDisputeAdminResolvable,
  type StripeDisputeSubject,
} from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import {
  ADMIN_REASON_PRESETS,
  ActionDialog,
  AdminPageHeader,
  CopyValue,
  DataTable,
  EmptyState,
  FilterBar,
  StatusChip,
  formatMoney,
  formatUtc,
  relativeTime,
  useAdminListUrlState,
  type DataColumn,
} from './shared';
import { STRIPE_DISPUTE_SEARCH_KEYS, readStripeDisputeFilters } from './stripeDisputeSearch';
import {
  useResolveStripeDispute,
  useStripeDisputes,
  useUndoContainStripeDispute,
  type StripeDisputeActionResult,
  type StripeDisputeRow,
} from '@client/app/hooks/data/stripeDisputes';
import { getErrorMessage } from '@client/app/utils/error';

export const SUBJECT_LABELS: Record<StripeDisputeSubject, string> = {
  user: 'User',
  organization: 'Organization',
  unmatched: 'No match',
};

const STATE_LABELS = { open: 'Open', resolved: 'Resolved' } as const;

const OUTCOME_LABELS = { won: 'Won', lost: 'Lost', admin: 'Resolved by admin' } as const;

const muted = { color: 'admin.inkMuted' } as const;

const Dash: React.FC = () => <Typography sx={muted}>-</Typography>;

/** "warning_needs_response" to "Warning needs response". */
export const humanizeReason = (value: string): string => {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const stripeStatusTone = (status: string): AdminStatusTone => {
  if (status === 'won') return 'good';
  if (status === 'lost') return 'bad';
  if (status === 'needs_response' || status === 'warning_needs_response') return 'warn';
  return 'neutral';
};

const canUndoContain = (row: StripeDisputeRow): boolean => !!row.contain && !row.contain.undoneAt;

const Time: React.FC<{ iso: string; now: number }> = ({ iso, now }) => {
  const date = new Date(iso);
  return (
    <Tooltip title={formatUtc(date)}>
      <Typography component="time" dateTime={date.toISOString()} tabIndex={0} level="body-sm" noWrap>
        {relativeTime(date, now)}
      </Typography>
    </Tooltip>
  );
};

const SubjectCell: React.FC<{ row: StripeDisputeRow }> = ({ row }) => (
  <Stack gap={0.25} sx={{ minWidth: 0 }}>
    <Typography level="body-sm" sx={{ color: 'admin.ink' }} data-testid={`stripe-dispute-subject-${row.id}`}>
      {SUBJECT_LABELS[row.subject]}
    </Typography>
    {row.subjectId &&
      (row.subject === 'user' ? (
        <Link
          to="/admin/users/$userId"
          params={{ userId: row.subjectId }}
          data-testid={`stripe-dispute-user-link-${row.id}`}
          style={{ textDecoration: 'none' }}
        >
          <Typography level="body-xs" fontFamily="code" noWrap sx={{ color: 'admin.link' }}>
            {row.subjectId}
          </Typography>
        </Link>
      ) : (
        <CopyValue
          value={row.subjectId}
          label="subject id"
          mono
          data-testid={`stripe-dispute-subject-copy-${row.id}`}
        />
      ))}
  </Stack>
);

const StateCell: React.FC<{ row: StripeDisputeRow }> = ({ row }) => {
  const outcome = row.resolution ? OUTCOME_LABELS[row.resolution.outcome] : null;
  return (
    <Stack gap={0.25} alignItems="flex-start">
      <StatusChip
        tone={row.state === 'open' ? 'warn' : 'neutral'}
        label={STATE_LABELS[row.state]}
        data-testid={`stripe-dispute-state-${row.id}`}
      />
      {outcome && (
        <Typography level="body-xs" sx={muted}>
          {outcome}
        </Typography>
      )}
    </Stack>
  );
};

const ContainCell: React.FC<{ row: StripeDisputeRow }> = ({ row }) => {
  if (!row.contain) return <Dash />;
  return row.contain.undoneAt ? (
    <StatusChip tone="neutral" label="Undone" data-testid={`stripe-dispute-contain-${row.id}`} />
  ) : (
    <StatusChip tone="bad" label="Contained" data-testid={`stripe-dispute-contain-${row.id}`} />
  );
};

const DisputeSummary: React.FC<{ row: StripeDisputeRow }> = ({ row }) => (
  <Stack gap={0.25} data-testid="stripe-dispute-dialog-summary">
    <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
      {formatMoney(row.amount, row.currency)} - {humanizeReason(row.reason)}
    </Typography>
    <Typography level="body-xs" sx={muted}>
      {SUBJECT_LABELS[row.subject]}
      {row.subjectId ? ` ${row.subjectId}` : ''}. Stripe status: {humanizeReason(row.stripeStatus)}.
    </Typography>
    <Typography level="body-xs" fontFamily="code" sx={muted}>
      {row.stripeDisputeId}
    </Typography>
  </Stack>
);

type DialogProps = { row: StripeDisputeRow; onClose: () => void; onRowChange: (row: StripeDisputeRow) => void };

const CONFLICT_FALLBACK_MESSAGE = 'This dispute changed since the list loaded. Review it again.';

/** Runs the action; on a conflict keeps the dialog open with the server's message. */
const useActionFlow = (
  row: StripeDisputeRow,
  run: (reason: string) => Promise<StripeDisputeActionResult>,
  { onClose, onRowChange }: Pick<DialogProps, 'onClose' | 'onRowChange'>
) => {
  const [conflict, setConflict] = useState<string | null>(null);
  const submit = async (reason: string) => {
    setConflict(null);
    const result = await run(reason);
    if (result.status === 'conflict') {
      if (result.item) onRowChange(result.item);
      setConflict(result.message ?? CONFLICT_FALLBACK_MESSAGE);
      return;
    }
    onClose();
  };
  return { conflict, submit };
};

const ResolveDialog: React.FC<DialogProps> = ({ row, onClose, onRowChange }) => {
  const mutation = useResolveStripeDispute();
  const { conflict, submit } = useActionFlow(row, reason => mutation.mutateAsync({ id: row.id, reason }), {
    onClose,
    onRowChange,
  });
  return (
    <ActionDialog
      open
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title="Resolve dispute"
      description="Resolving only closes this record. It does not change any account, flag or credits."
      reasonPresets={ADMIN_REASON_PRESETS.stripeDisputeResolve}
      confirmLabel="Resolve dispute"
      // After a conflict the row is the server's current one, which may no longer take this action.
      blockedReason={
        isStripeDisputeAdminResolvable(row) ? null : 'This dispute is no longer open for an admin to resolve.'
      }
      pending={mutation.isPending}
      onConfirm={submit}
      data-testid="stripe-dispute-resolve-dialog"
    >
      <DisputeSummary row={row} />
      {conflict && (
        <Alert color="warning" data-testid="stripe-dispute-resolve-conflict">
          {conflict}
        </Alert>
      )}
      {mutation.error && (
        <Alert color="danger" data-testid="stripe-dispute-resolve-error">
          {getErrorMessage(mutation.error)}
        </Alert>
      )}
    </ActionDialog>
  );
};

const UndoContainDialog: React.FC<DialogProps> = ({ row, onClose, onRowChange }) => {
  const mutation = useUndoContainStripeDispute();
  const { conflict, submit } = useActionFlow(row, reason => mutation.mutateAsync({ id: row.id, reason }), {
    onClose,
    onRowChange,
  });
  const contain = row.contain;
  const credits = contain ? Math.abs(contain.creditDelta) : 0;
  return (
    <ActionDialog
      open
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title="Undo contain"
      description="The dispute flag stays set, so the account remains blocked until the flag is cleared."
      reasonPresets={ADMIN_REASON_PRESETS.stripeDisputeUndoContain}
      confirmLabel="Undo contain"
      blockedReason={canUndoContain(row) ? null : 'There is no active contain to undo.'}
      pending={mutation.isPending}
      onConfirm={submit}
      data-testid="stripe-dispute-undo-dialog"
    >
      <DisputeSummary row={row} />
      <Stack gap={0.5} data-testid="stripe-dispute-undo-preview">
        <Typography level="body-xs" sx={muted}>
          This restores
        </Typography>
        <Typography component="ul" level="body-sm" sx={{ m: 0, pl: 2.5 }}>
          {contain?.suspended && <li>The account is unsuspended.</li>}
          {credits > 0 && <li>{credits.toLocaleString('en-US')} credits are returned to the balance.</li>}
          {contain && contain.apiKeysRevoked > 0 && (
            <li>
              {contain.apiKeysRevoked.toLocaleString('en-US')} revoked API keys stay revoked; the user creates new ones.
            </li>
          )}
          {contain && !contain.suspended && credits === 0 && contain.apiKeysRevoked === 0 && (
            <li>Nothing to restore: the containment changed no suspension, credits or API keys.</li>
          )}
        </Typography>
      </Stack>
      {conflict && (
        <Alert color="warning" data-testid="stripe-dispute-undo-conflict">
          {conflict}
        </Alert>
      )}
      {mutation.error && (
        <Alert color="danger" data-testid="stripe-dispute-undo-error">
          {getErrorMessage(mutation.error)}
        </Alert>
      )}
    </ActionDialog>
  );
};

type ActiveDialog = { kind: 'resolve' | 'undo'; row: StripeDisputeRow };

/**
 * Stripe disputes. A lost dispute on a user's payment is resolved automatically and contains the
 * account; organization and unmatched disputes wait here for an admin to close them.
 */
export const StripeDisputesTab: React.FC = () => {
  const [view, updateView] = useAdminListUrlState(STRIPE_DISPUTE_SEARCH_KEYS);
  const query = readStripeDisputeFilters(view.filters);
  const disputes = useStripeDisputes(query);
  const [active, setActive] = useState<ActiveDialog | null>(null);
  const [now] = useState(() => Date.now());

  const rows = disputes.data?.data ?? [];
  const filtered = query.state !== undefined || query.subject !== undefined;

  const columns: readonly DataColumn<StripeDisputeRow>[] = [
    {
      id: 'openedAt',
      label: 'Opened',
      render: row => <Time iso={row.openedAt} now={now} />,
      sortValue: row => row.openedAt,
      width: '8rem',
    },
    {
      id: 'dispute',
      label: 'Dispute',
      render: row => (
        <CopyValue
          value={row.stripeDisputeId}
          label="dispute id"
          mono
          data-testid={`stripe-dispute-id-copy-${row.id}`}
        />
      ),
      width: '14rem',
    },
    { id: 'subject', label: 'Subject', render: row => <SubjectCell row={row} />, width: '14rem' },
    {
      id: 'amount',
      label: 'Amount',
      render: row => <Typography level="body-sm">{formatMoney(row.amount, row.currency)}</Typography>,
      sortValue: row => row.amount,
      numeric: true,
      width: '7rem',
    },
    {
      id: 'reason',
      label: 'Reason',
      render: row => <Typography level="body-sm">{humanizeReason(row.reason)}</Typography>,
      sortValue: row => row.reason,
      width: '10rem',
    },
    {
      id: 'stripeStatus',
      label: 'Stripe status',
      render: row => (
        <StatusChip
          tone={stripeStatusTone(row.stripeStatus)}
          label={humanizeReason(row.stripeStatus)}
          data-testid={`stripe-dispute-status-${row.id}`}
        />
      ),
      sortValue: row => row.stripeStatus,
      width: '10rem',
    },
    { id: 'state', label: 'State', render: row => <StateCell row={row} />, width: '9rem' },
    { id: 'contain', label: 'Contain', render: row => <ContainCell row={row} />, width: '7rem' },
  ];

  const rowActions = (row: StripeDisputeRow) => (
    <>
      {isStripeDisputeAdminResolvable(row) && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          data-testid={`stripe-dispute-resolve-btn-${row.id}`}
          onClick={() => setActive({ kind: 'resolve', row })}
        >
          Resolve
        </Button>
      )}
      {canUndoContain(row) && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          data-testid={`stripe-dispute-undo-btn-${row.id}`}
          onClick={() => setActive({ kind: 'undo', row })}
        >
          Undo contain
        </Button>
      )}
    </>
  );

  const changeRow = (kind: ActiveDialog['kind']) => (row: StripeDisputeRow) => setActive({ kind, row });

  return (
    <Stack
      spacing={2}
      sx={{ bgcolor: 'admin.canvas', color: 'admin.ink', p: 2, borderRadius: 'md', minWidth: 0 }}
      data-testid="admin-stripe-disputes-tab"
    >
      <AdminPageHeader
        title="Disputes"
        count={disputes.data && !disputes.data.truncated ? rows.length : undefined}
        description="Lost disputes on a user's payment are resolved automatically and contain the account. Organization and unmatched disputes wait here."
      />
      {disputes.data?.truncated && (
        <Alert color="warning" data-testid="stripe-dispute-truncated">
          Showing the {STRIPE_DISPUTE_LIST_LIMIT.toLocaleString()} most recent disputes. Narrow the filters to see older
          ones.
        </Alert>
      )}
      <FilterBar
        search={false}
        state={{ ...view, filters: { state: query.state ?? '', subject: query.subject ?? '' } }}
        onChange={patch => {
          if (!patch.filters) return;
          updateView({ filters: { state: patch.filters.state ?? '', subject: patch.filters.subject ?? '' }, view: '' });
        }}
        filters={[
          {
            id: 'state',
            label: 'State',
            options: STRIPE_DISPUTE_STATES.map(value => ({ value, label: STATE_LABELS[value] })),
          },
          {
            id: 'subject',
            label: 'Subject',
            options: STRIPE_DISPUTE_SUBJECTS.map(value => ({ value, label: SUBJECT_LABELS[value] })),
          },
        ]}
      />
      <DataTable
        rows={rows}
        columns={columns}
        label="Stripe disputes"
        getRowId={row => row.id}
        pageResetKey={JSON.stringify([query.state, query.subject])}
        testId="stripe-dispute-table"
        rowTestId={row => `stripe-dispute-row-${row.id}`}
        loading={disputes.isPending}
        error={disputes.error ? "Couldn't load disputes." : undefined}
        onRetry={() => void disputes.refetch()}
        rowActions={rowActions}
        minWidth="76rem"
        empty={
          <EmptyState
            title={filtered ? 'No disputes match these filters' : 'No disputes'}
            description={filtered ? undefined : 'Stripe disputes appear here as they are opened.'}
            action={
              <Button
                variant="outlined"
                data-testid="stripe-dispute-reset-btn"
                onClick={() => {
                  if (filtered) updateView({ filters: {}, view: '' });
                  else void disputes.refetch();
                }}
              >
                {filtered ? 'Clear filters' : 'Refresh'}
              </Button>
            }
          />
        }
      />
      {active?.kind === 'resolve' && (
        <ResolveDialog row={active.row} onClose={() => setActive(null)} onRowChange={changeRow('resolve')} />
      )}
      {active?.kind === 'undo' && (
        <UndoContainDialog row={active.row} onClose={() => setActive(null)} onRowChange={changeRow('undo')} />
      )}
    </Stack>
  );
};

export default StripeDisputesTab;
