import React, { useState } from 'react';
import { Alert, Button, Stack, Tooltip, Typography } from '@mui/joy';
import { SIGNUP_RISK_AUTO_APPROVAL_LIST_DAYS, type SignupRiskAutoApprovalPolicy } from '@bike4mind/common';
import { ADMIN_REASON_PRESETS, ActionDialog, DataTable, StatusChip, relativeTime, type DataColumn } from './shared';
import { useOpenUserProfile } from './Users/Profile/useOpenUserProfile';
import { useSignupRiskReviewDecision, type SignupRiskAutoApprovalRow } from '@client/app/hooks/data/signupRiskReviews';
import { getErrorMessage } from '@client/app/utils/error';

export const AUTO_APPROVAL_POLICY_LABELS: Record<SignupRiskAutoApprovalPolicy, string> = {
  settled_payment: 'Settled payment',
  quiet_account: 'Quiet account',
};

/**
 * Accounts the signupRiskAutoApproval rules approved without an admin, still approved, from the last
 * SIGNUP_RISK_AUTO_APPROVAL_LIST_DAYS days. Reopening puts one back in the review queue and holds AI access again.
 */
export const SignupRiskAutoApprovals: React.FC<{
  rows: SignupRiskAutoApprovalRow[];
  now: number;
  onRetry: () => void;
}> = ({ rows, now, onRetry }) => {
  const decision = useSignupRiskReviewDecision();
  const openProfile = useOpenUserProfile();
  const [reopening, setReopening] = useState<SignupRiskAutoApprovalRow | null>(null);

  if (rows.length === 0) return null;

  const columns: readonly DataColumn<SignupRiskAutoApprovalRow>[] = [
    {
      id: 'account',
      label: 'Account',
      render: row => (
        <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
          {row.email ?? row.username ?? row.userId}
        </Typography>
      ),
      sortValue: row => row.email ?? row.username ?? row.userId,
    },
    {
      id: 'policy',
      label: 'Evidence',
      render: row => <StatusChip tone="neutral" label={AUTO_APPROVAL_POLICY_LABELS[row.policy]} />,
      sortValue: row => row.policy,
      width: '10rem',
    },
    {
      id: 'score',
      label: 'Risk score',
      render: row => row.score ?? '-',
      sortValue: row => row.score ?? -1,
      numeric: true,
      width: '7rem',
    },
    {
      id: 'decidedAt',
      label: 'Approved',
      render: row => (
        <Tooltip title={row.decidedAt}>
          <Typography component="time" dateTime={row.decidedAt} tabIndex={0} level="body-sm" noWrap>
            {relativeTime(new Date(row.decidedAt), now)}
          </Typography>
        </Tooltip>
      ),
      sortValue: row => row.decidedAt,
      width: '8rem',
    },
  ];

  return (
    <Stack spacing={1} data-testid="signup-risk-auto-approved">
      <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
        Approved automatically
      </Typography>
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
        Approved by the Signup Risk Auto-Approval rules in the last {SIGNUP_RISK_AUTO_APPROVAL_LIST_DAYS} days. Reopen
        one to put it back in the queue.
      </Typography>
      <DataTable
        rows={rows}
        columns={columns}
        label="Accounts approved automatically"
        getRowId={row => row.userId}
        onRetry={onRetry}
        testId="signup-risk-auto-approved-table"
        rowTestId={row => `signup-risk-auto-approved-row-${row.userId}`}
        onRowActivate={row => void openProfile(row.userId)}
        rowActions={row => (
          <Button
            size="sm"
            variant="outlined"
            data-testid={`signup-risk-reopen-${row.userId}`}
            onClick={() => {
              decision.reset();
              setReopening(row);
            }}
          >
            Reopen review
          </Button>
        )}
      />
      <ActionDialog
        open={reopening !== null}
        onClose={() => {
          if (!decision.isPending) setReopening(null);
        }}
        title="Reopen review"
        description="This puts the account back in the review queue and holds its AI access again until an admin approves it."
        reasonPresets={ADMIN_REASON_PRESETS.signupRiskReopen}
        confirmLabel="Reopen review"
        pending={decision.isPending}
        onConfirm={reason => {
          if (!reopening) return;
          decision.mutate(
            { action: 'reopen', userIds: [reopening.userId], reason },
            { onSuccess: () => setReopening(null) }
          );
        }}
        data-testid="signup-risk-reopen-dialog"
        testIds={{ confirm: 'signup-risk-reopen-confirm-btn', reason: 'signup-risk-reopen-reason' }}
      >
        {decision.error && <Alert color="danger">{getErrorMessage(decision.error)}</Alert>}
      </ActionDialog>
    </Stack>
  );
};
