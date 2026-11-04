import React from 'react';
import { Alert, Stack, Typography } from '@mui/joy';
import {
  useAdminSubscriptionSync,
  useAdminSubscriptionSyncPreview,
} from '@client/app/hooks/data/adminSubscriptionDetail';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, useUndoToast } from '../../../shared';
import { ownerDisplayName, type SubscriptionDialogProps } from '../subscriptionDetailModel';

const show = (value: string | null) => value ?? '-';

/**
 * Sync from Stripe: previews a live Stripe read, then makes our record (and an organization's seats)
 * match it. Mongo only; Stripe is never written. There is no undo, the next Stripe event would overwrite it.
 */
export const SyncFromStripeDialog: React.FC<SubscriptionDialogProps> = ({ detail, onClose, onAudit }) => {
  const { subscription } = detail;
  const preview = useAdminSubscriptionSyncPreview(subscription.id);
  const sync = useAdminSubscriptionSync(subscription.id);
  const showUndo = useUndoToast();
  const data = preview.data;

  const handleConfirm = async (reason: string) => {
    if (!data) return;
    try {
      await sync.mutateAsync({ expectedUpdatedAt: data.updatedAt, reason });
    } catch (error) {
      // The preview is stale after a conflict; reread it so the next confirm carries the new updatedAt.
      void preview.refetch();
      throw error;
    }
    onClose();
    showUndo({ message: 'Synced from Stripe', onViewAudit: onAudit });
  };

  const blockedReason = preview.isError
    ? 'Could not read the subscription from Stripe. Close this and try again.'
    : preview.isLoading
      ? 'Reading from Stripe...'
      : data && data.changes.length === 0
        ? 'Already in sync with Stripe.'
        : null;

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Sync from Stripe"
      description={`Makes the record for ${ownerDisplayName(subscription)} match Stripe. Stripe is not changed.`}
      reasonPresets={ADMIN_REASON_PRESETS.subscriptionSync}
      confirmLabel="Sync from Stripe"
      blockedReason={blockedReason}
      onConfirm={handleConfirm}
      data-testid="sync-subscription-dialog"
    >
      <Stack gap={1}>
        {data?.stripeMissing && (
          <Alert color="warning" data-testid="sync-subscription-missing">
            Stripe has no such subscription. Syncing marks this record canceled.
          </Alert>
        )}
        {data?.changes.map(change => (
          <Stack key={change.field} gap={0.5}>
            <Typography level="body-sm">{change.field}</Typography>
            <ChangePreview
              before={show(change.before)}
              after={show(change.after)}
              data-testid={`sync-subscription-change-${change.field}`}
            />
          </Stack>
        ))}
      </Stack>
    </ActionDialog>
  );
};
