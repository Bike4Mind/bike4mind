import { useState } from 'react';
import { Alert, List, ListItem, Stack, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AccessReviewRow } from '@client/app/hooks/data/adminAccessReview';
import { ActionDialog, StatusChip } from '../shared';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { REVOKE_REASON_PRESETS } from './RevokeAccessDialog';
import { revokeAdmins, type BulkRevokeOutcome, type BulkRevokeState } from './revokeAdminAccess';

type BulkRevokeAccessDialogProps = {
  admins: readonly AccessReviewRow[];
  dormantDays: number;
  onClose: () => void;
  /** Called after each run with the accounts whose revocation is recorded, so the page can drop them from its selection. */
  onRevoked: (userIds: string[]) => void;
};

const OUTCOME_CHIP: Record<BulkRevokeState, { tone: AdminStatusTone; label: string }> = {
  revoked: { tone: 'good', label: 'Revoked' },
  unrecorded: { tone: 'warn', label: 'Not recorded' },
  failed: { tone: 'bad', label: 'Not revoked' },
  skipped: { tone: 'neutral', label: 'Not started' },
};

const adminLabel = (admin: AccessReviewRow) => admin.email ?? admin.username ?? admin.userId;

/** Revokes several admins in one step; each still goes through the audited per-admin routes. */
export function BulkRevokeAccessDialog({ admins, dormantDays, onClose, onRevoked }: BulkRevokeAccessDialogProps) {
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, BulkRevokeOutcome> | null>(null);
  const queryClient = useQueryClient();
  const retryable = outcomes
    ? [...outcomes.values()].some(outcome => outcome.state === 'unrecorded' || outcome.state === 'skipped')
    : true;

  const run = async (reason: string) => {
    const results = await revokeAdmins(admins, reason, dormantDays, outcomes ?? undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin'] }),
      queryClient.invalidateQueries({ queryKey: ['users'] }),
    ]);
    const revoked = results.filter(outcome => outcome.state === 'revoked').map(outcome => outcome.userId);
    onRevoked(revoked);
    if (revoked.length === admins.length) {
      toast.success(`Revoked admin access for ${revoked.length} ${revoked.length === 1 ? 'account' : 'accounts'}.`);
      onClose();
      return;
    }
    setOutcomes(new Map(results.map(outcome => [outcome.userId, outcome])));
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Revoke admin access for ${admins.length} ${admins.length === 1 ? 'account' : 'accounts'}`}
      description="Each account loses the Super Admin role, every delegated admin permission and every admin role. Each revocation is recorded with you as the reviewer and lands in the audit log."
      reasonPresets={REVOKE_REASON_PRESETS}
      reasonRequired={!outcomes}
      confirmLabel={outcomes ? 'Retry' : `Revoke ${admins.length}`}
      onConfirm={run}
      blockedReason={retryable ? null : 'Nothing left to retry. Review the refused accounts one by one.'}
      tone="danger"
      data-testid="admin-access-review-bulk-revoke-dialog"
    >
      <Stack gap={1}>
        {outcomes && (
          <Alert color="warning" data-testid="admin-access-review-bulk-revoke-partial">
            Some accounts were not revoked. Retry records the ones whose access was already removed and continues any
            not started.
          </Alert>
        )}
        <List size="sm" data-testid="admin-access-review-bulk-revoke-list" sx={{ '--ListItem-paddingX': 0 }}>
          {admins.map(admin => {
            const outcome = outcomes?.get(admin.userId);
            return (
              <ListItem key={admin.userId} data-testid={`admin-access-review-bulk-revoke-item-${admin.userId}`}>
                <Stack sx={{ minWidth: 0, width: '100%' }}>
                  <Stack direction="row" alignItems="center" gap={1} sx={{ minWidth: 0 }}>
                    <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
                      {adminLabel(admin)}
                    </Typography>
                    {outcome && (
                      <StatusChip tone={OUTCOME_CHIP[outcome.state].tone} label={OUTCOME_CHIP[outcome.state].label} />
                    )}
                  </Stack>
                  {outcome?.message && (
                    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                      {outcome.message}
                    </Typography>
                  )}
                </Stack>
              </ListItem>
            );
          })}
        </List>
      </Stack>
    </ActionDialog>
  );
}
