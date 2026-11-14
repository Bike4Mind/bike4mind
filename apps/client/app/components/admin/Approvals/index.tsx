import React, { useState } from 'react';
import { Box, Button, FormControl, FormLabel, Input, MenuItem, Option, Select, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { AdminApprovalAction, AdminApprovalStatus } from '@bike4mind/common';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { AdminDialog } from '@client/app/components/admin/shared/AdminDialog';
import { AdminPageHeader } from '@client/app/components/admin/shared/AdminPageHeader';
import { ADMIN_REGION_GAP } from '@client/app/components/admin/shared/adminStyles';
import { DataTable, type DataColumn } from '@client/app/components/admin/shared/DataTable';
import { EmptyState } from '@client/app/components/admin/shared/EmptyState';
import { RowActionsMenu } from '@client/app/components/admin/shared/RowActionsMenu';
import { StatusChip } from '@client/app/components/admin/shared/StatusChip';
import { AdminUsersBulkResultSchema } from '@bike4mind/server-utils/app/utils/adminUsersBulk';
import { useUsersBulkResult } from '../Users/List/useUsersBulkResult';
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

const STATUS_FILTERS: AdminApprovalStatusFilter[] = [
  'pending',
  'approved',
  'executing',
  'executed',
  'rejected',
  'expired',
  'failed',
  'all',
];

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
  'user.schedule_admin_deletion': 'Schedule deletion for an admin',
};

const summaryOf = (row: AdminApprovalRow) => row.summary ?? ACTION_LABELS[row.action];

const REJECT_PRESETS = ['Not justified', 'Wrong target', 'Needs more detail'] as const;
const IMPERSONATION_PRESETS = ['Reproducing a customer issue', 'Investigating a reported problem'] as const;

const decideHint = (row: AdminApprovalRow) =>
  row.own ? 'Another admin must approve your own request.' : 'You do not have the permission this request needs.';

const formatTime = (iso: string) => new Date(iso).toLocaleString();

const targetUserIdOf = (row: AdminApprovalRow) =>
  typeof row.params === 'object' && row.params !== null
    ? String((row.params as { targetUserId?: unknown }).targetUserId ?? '')
    : '';

const hasParams = (row: AdminApprovalRow) =>
  typeof row.params === 'object' && row.params !== null && Object.keys(row.params).length > 0;

const userIdsOf = (row: AdminApprovalRow): string[] | null => {
  const ids = (row.params as { target?: { userIds?: unknown } } | null)?.target?.userIds;
  return row.action === 'users.bulk' && Array.isArray(ids) ? ids.map(String).sort() : null;
};

const ParamsDialog: React.FC<{ row: AdminApprovalRow; onClose: () => void }> = ({ row, onClose }) => {
  const userIds = userIdsOf(row);
  return (
    <AdminDialog onClose={onClose} title={summaryOf(row)} width={560} data-testid="admin-approval-details-dialog">
      <Stack spacing={1} sx={{ maxHeight: '70vh', overflow: 'auto' }}>
        {userIds && (
          <Stack spacing={0.5}>
            <Typography level="body-sm" fontWeight={500}>
              {userIds.length} users
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5 }} data-testid="admin-approval-details-user-ids">
              {userIds.map(id => (
                <li key={id}>
                  <Typography level="body-xs" sx={{ fontFamily: 'code' }}>
                    {id}
                  </Typography>
                </li>
              ))}
            </Box>
          </Stack>
        )}
        {row.result !== undefined && (
          <>
            <Typography level="body-sm" fontWeight={500}>
              Execution result
            </Typography>
            <Box
              component="pre"
              sx={{ m: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
              data-testid="admin-approval-details-result"
            >
              {JSON.stringify(row.result, null, 2)}
            </Box>
          </>
        )}
        {row.error && (
          <Typography level="body-sm" color="danger">
            {row.error}
          </Typography>
        )}
        <Typography level="body-sm" fontWeight={500}>
          Parameters
        </Typography>
        <Box
          component="pre"
          sx={{ m: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          data-testid="admin-approval-details-params"
        >
          {JSON.stringify(row.params, null, 2)}
        </Box>
      </Stack>
    </AdminDialog>
  );
};

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
  const showBulkResult = useUsersBulkResult();
  const reject = useRejectAdminApproval();
  const [rejecting, setRejecting] = useState<AdminApprovalRow | null>(null);
  const [impersonating, setImpersonating] = useState<AdminApprovalRow | null>(null);
  const [inspecting, setInspecting] = useState<AdminApprovalRow | null>(null);

  const onApprove = async (row: AdminApprovalRow) => {
    try {
      const response = await approve.mutateAsync(row.id);
      if (row.action === 'users.bulk') {
        const result = AdminUsersBulkResultSchema.safeParse(response.result);
        if (!result.success) {
          toast.warning(
            'The action finished, but its result could not be read. Refresh and inspect the request details.'
          );
          return;
        }
        showBulkResult(result.data);
        setInspecting({ ...row, ...response.approval, result: response.result });
        return;
      }
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
      wrap: true,
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
    { id: 'requester', label: 'Requested by', render: row => row.requestedBy?.name || row.requestedBy?.email || '-' },
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
    const showDetails = hasParams(row) || row.result !== undefined || !!row.error;
    const canStartImpersonation =
      row.status === 'approved' &&
      row.action === 'user.impersonate_admin' &&
      !!row.requestedBy &&
      row.requestedBy.id === currentUser?.id;
    const isPending = row.status === 'pending';
    if (!showDetails && !canStartImpersonation && !isPending) return null;
    const isRequester = !!row.own;
    const hint = decideHint(row);
    return (
      <RowActionsMenu testId={`admin-approval-actions-${row.id}`} ariaLabel={`Actions for ${summaryOf(row)}`}>
        {showDetails && (
          <MenuItem onClick={() => setInspecting(row)} data-testid="admin-approval-details-btn">
            Details
          </MenuItem>
        )}
        {canStartImpersonation && (
          <MenuItem onClick={() => setImpersonating(row)} data-testid="admin-approval-start-impersonation-btn">
            Start impersonation
          </MenuItem>
        )}
        {isPending && (
          <MenuItem
            disabled={!row.canDecide || approve.isPending}
            title={row.canDecide ? undefined : hint}
            onClick={() => void onApprove(row)}
            data-testid="admin-approve-btn"
          >
            Approve
          </MenuItem>
        )}
        {/* The server lets the requester withdraw, and otherwise rejects on the same check as approve. */}
        {isPending && (
          <MenuItem
            disabled={!isRequester && !row.canDecide}
            title={isRequester || row.canDecide ? undefined : hint}
            onClick={() => setRejecting(row)}
            data-testid={isRequester ? 'admin-withdraw-btn' : 'admin-reject-btn'}
          >
            {isRequester ? 'Withdraw' : 'Reject'}
          </MenuItem>
        )}
      </RowActionsMenu>
    );
  };

  return (
    <Stack spacing={ADMIN_REGION_GAP} data-testid="admin-approvals-queue">
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
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => setStatus('all')}
                data-testid="admin-approvals-show-all-btn"
              >
                Show all requests
              </Button>
            }
          />
        }
        rowTestId={row => `admin-approval-row-${row.id}`}
        rowActions={rowActions}
        pagination={false}
      />
      {approvals.hasNextPage && (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={() => void approvals.fetchNextPage()}
          loading={approvals.isFetchingNextPage}
          sx={{ alignSelf: 'flex-start' }}
          data-testid="admin-approvals-load-more-btn"
        >
          Load more requests
        </Button>
      )}
      {rejecting && (
        <ActionDialog
          open
          onClose={() => setRejecting(null)}
          title={rejecting.own ? 'Withdraw request' : 'Reject request'}
          description={`Closes "${summaryOf(rejecting)}" without running it.`}
          reasonPresets={REJECT_PRESETS}
          confirmLabel={rejecting.own ? 'Withdraw request' : 'Reject request'}
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
      {inspecting && <ParamsDialog row={inspecting} onClose={() => setInspecting(null)} />}
      {impersonating && <StartImpersonationDialog row={impersonating} onClose={() => setImpersonating(null)} />}
    </Stack>
  );
};

export default Approvals;
