import React, { useState } from 'react';
import { Box, Button, FormControl, FormLabel, Input, Option, Select, Stack, Tooltip, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { AdminApprovalAction, AdminApprovalStatus } from '@bike4mind/common';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { AdminPageHeader } from '@client/app/components/admin/shared/AdminPageHeader';
import { DataTable, type DataColumn } from '@client/app/components/admin/shared/DataTable';
import { EmptyState } from '@client/app/components/admin/shared/EmptyState';
import { StatusChip } from '@client/app/components/admin/shared/StatusChip';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { useUser } from '@client/app/contexts/UserContext';
import {
  type AdminApprovalRow,
  type AdminApprovalStatusFilter,
  useAdminApprovals,
  useApproveAdminApproval,
  useRejectAdminApproval,
} from '@client/app/hooks/data/adminApprovals';
import { useLoginAsUser } from '@client/app/hooks/data/user';
import { getErrorMessage } from '@client/app/utils/error';

const STATUS_FILTERS: AdminApprovalStatusFilter[] = ['pending', 'approved', 'executed', 'rejected', 'failed', 'all'];

const STATUS_TONES: Record<AdminApprovalStatus, AdminStatusTone> = {
  pending: 'warn',
  executing: 'info',
  approved: 'info',
  executed: 'good',
  rejected: 'neutral',
  expired: 'neutral',
  failed: 'bad',
};

const ACTION_LABELS: Record<AdminApprovalAction, string> = {
  'users.bulk': 'Bulk user action',
  'org.credits.grant': 'Organization credit grant',
  'org.credits.top_up': 'Organization credit top-up',
  'user.subscription.grant': 'User subscription grant',
  'user.impersonate_admin': 'Impersonate an admin',
  'user.delete_admin': 'Delete an admin',
};

const summaryOf = (row: AdminApprovalRow) => row.summary ?? ACTION_LABELS[row.action];

const REJECT_PRESETS = ['Not justified', 'Wrong target', 'Needs more detail'] as const;
const IMPERSONATION_PRESETS = ['Reproducing a customer issue', 'Investigating a reported problem'] as const;

const decideHint = (row: AdminApprovalRow, ownId: string | undefined) =>
  row.requestedBy.id === ownId
    ? 'Another admin must approve your own request.'
    : 'You do not have the permission this request needs.';

const formatTime = (iso: string) => new Date(iso).toLocaleString();

const targetUserIdOf = (row: AdminApprovalRow) =>
  typeof row.params === 'object' && row.params !== null
    ? String((row.params as { targetUserId?: unknown }).targetUserId ?? '')
    : '';

const StartImpersonationDialog: React.FC<{ row: AdminApprovalRow; onClose: () => void }> = ({ row, onClose }) => {
  const loginAs = useLoginAsUser();
  const [mfaToken, setMfaToken] = useState('');
  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Start approved impersonation"
      description={`Uses the approval for "${summaryOf(row)}". The session is audited and time-boxed.`}
      reasonPresets={IMPERSONATION_PRESETS}
      confirmLabel="Start impersonation"
      blockedReason={mfaToken.trim() ? null : 'Enter your 6-digit authenticator code.'}
      onConfirm={async reason => {
        await loginAs.mutateAsync({ id: targetUserIdOf(row), mfaToken: mfaToken.trim(), reason, approvalId: row.id });
        onClose();
      }}
      pending={loginAs.isPending}
      data-testid="admin-approval-impersonation-dialog"
    >
      <FormControl>
        <FormLabel>Your authenticator code</FormLabel>
        <Input
          autoFocus
          placeholder="6-digit code"
          value={mfaToken}
          onChange={event => setMfaToken(event.target.value)}
          slotProps={{ input: { maxLength: 10, autoComplete: 'one-time-code' } }}
        />
      </FormControl>
    </ActionDialog>
  );
};

const Approvals: React.FC = () => {
  const { currentUser } = useUser();
  const [status, setStatus] = useState<AdminApprovalStatusFilter>('pending');
  const approvals = useAdminApprovals(status);
  const approve = useApproveAdminApproval();
  const reject = useRejectAdminApproval();
  const [rejecting, setRejecting] = useState<AdminApprovalRow | null>(null);
  const [impersonating, setImpersonating] = useState<AdminApprovalRow | null>(null);

  const onApprove = async (row: AdminApprovalRow) => {
    try {
      await approve.mutateAsync(row.id);
      toast.success(
        row.action === 'user.impersonate_admin' ? 'Approved. The requester can now start it.' : 'Approved and run.'
      );
    } catch (error) {
      toast.error(`Approve failed: ${getErrorMessage(error)}`);
    }
  };

  const columns: DataColumn<AdminApprovalRow>[] = [
    {
      id: 'summary',
      label: 'Request',
      render: row => (
        <Stack spacing={0.25}>
          <Typography level="body-sm" fontWeight={500}>
            {summaryOf(row)}
          </Typography>
          {row.reason !== null && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
              {row.reason}
            </Typography>
          )}
        </Stack>
      ),
    },
    { id: 'requester', label: 'Requested by', render: row => row.requestedBy.name || row.requestedBy.email },
    { id: 'expires', label: 'Expires', render: row => formatTime(row.expiresAt) },
    {
      id: 'status',
      label: 'Status',
      render: row => (
        <Stack direction="row" spacing={0.5}>
          <StatusChip tone={STATUS_TONES[row.status]} label={row.status} />
          {row.stalled && <StatusChip tone="bad" label="stalled" />}
        </Stack>
      ),
    },
  ];

  const rowActions = (row: AdminApprovalRow) => {
    if (
      row.status === 'approved' &&
      row.action === 'user.impersonate_admin' &&
      row.requestedBy.id === currentUser?.id
    ) {
      return (
        <Button
          size="sm"
          variant="outlined"
          onClick={() => setImpersonating(row)}
          data-testid="admin-approval-start-impersonation-btn"
        >
          Start impersonation
        </Button>
      );
    }
    if (row.status !== 'pending') return null;
    const hint = row.canDecide ? '' : decideHint(row, currentUser?.id);
    return (
      <Stack direction="row" spacing={0.5}>
        <Tooltip title={hint} disableHoverListener={row.canDecide}>
          <span>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              disabled={!row.canDecide || approve.isPending}
              onClick={() => void onApprove(row)}
              data-testid="admin-approve-btn"
            >
              Approve
            </Button>
          </span>
        </Tooltip>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setRejecting(row)}
          data-testid="admin-reject-btn"
        >
          {row.requestedBy.id === currentUser?.id ? 'Withdraw' : 'Reject'}
        </Button>
      </Stack>
    );
  };

  return (
    <Box data-testid="admin-approvals-queue">
      <AdminPageHeader
        title="Approvals"
        count={approvals.data?.length}
        description="Sensitive admin actions wait here until a second admin approves them."
        actions={
          <Select
            size="sm"
            value={status}
            onChange={(_event, value) => value && setStatus(value)}
            aria-label="Status"
            data-testid="admin-approvals-status-select"
          >
            {STATUS_FILTERS.map(value => (
              <Option key={value} value={value}>
                {value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1)}
              </Option>
            ))}
          </Select>
        }
      />
      <DataTable
        rows={approvals.data ?? []}
        columns={columns}
        getRowId={row => row.id}
        label="Approval requests"
        loading={approvals.isLoading}
        error={approvals.error ? getErrorMessage(approvals.error) : undefined}
        onRetry={() => void approvals.refetch()}
        empty={
          <EmptyState
            title="Nothing waiting"
            description="Requests appear here when an action needs a second admin."
            action={
              <Button size="sm" variant="outlined" color="neutral" onClick={() => setStatus('all')}>
                Show all requests
              </Button>
            }
          />
        }
        rowTestId={row => `admin-approval-row-${row.id}`}
        rowActions={rowActions}
        pagination={false}
      />
      {rejecting && (
        <ActionDialog
          open
          onClose={() => setRejecting(null)}
          title={rejecting.requestedBy.id === currentUser?.id ? 'Withdraw request' : 'Reject request'}
          description={`Closes "${summaryOf(rejecting)}" without running it.`}
          reasonPresets={REJECT_PRESETS}
          confirmLabel={rejecting.requestedBy.id === currentUser?.id ? 'Withdraw request' : 'Reject request'}
          tone="danger"
          pending={reject.isPending}
          onConfirm={async reason => {
            try {
              await reject.mutateAsync({ id: rejecting.id, reason });
              setRejecting(null);
            } catch (error) {
              toast.error(`Reject failed: ${getErrorMessage(error)}`);
            }
          }}
          data-testid="admin-approval-reject-dialog"
        />
      )}
      {impersonating && <StartImpersonationDialog row={impersonating} onClose={() => setImpersonating(null)} />}
    </Box>
  );
};

export default Approvals;
