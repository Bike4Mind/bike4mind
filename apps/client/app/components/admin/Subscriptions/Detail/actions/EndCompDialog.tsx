import React from 'react';
import { useAdminSubscriptionCompChange } from '@client/app/hooks/data/adminSubscriptionDetail';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, StatusChip, useUndoToast } from '../../../shared';
import { subscriptionStatusDisplay } from '../subscriptionStatus';
import { ownerDisplayName, undoReason, type SubscriptionDialogProps } from '../subscriptionDetailModel';

/** End comp: cancels the comp now; undo reopens it with its original end date. */
export const EndCompDialog: React.FC<SubscriptionDialogProps> = ({ detail, onClose, onAudit }) => {
  const { subscription } = detail;
  const change = useAdminSubscriptionCompChange(subscription.id);
  const showUndo = useUndoToast();
  const before = subscriptionStatusDisplay(subscription.status);
  const after = subscriptionStatusDisplay('canceled');
  const name = ownerDisplayName(subscription);

  const handleConfirm = async (reason: string) => {
    await change.mutateAsync({ action: 'end', reason });
    onClose();
    showUndo({
      message: `Comp ended for ${name}`,
      onUndo: async () => {
        await change.mutateAsync({ action: 'reopen', reason: undoReason(reason) });
      },
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="End comp"
      description={`${name} loses the plan now. Credits already granted stay with the owner.`}
      reasonPresets={ADMIN_REASON_PRESETS.compChange}
      confirmLabel="End comp now"
      tone="danger"
      onConfirm={handleConfirm}
      data-testid="end-comp-dialog"
    >
      <ChangePreview
        before={<StatusChip tone={before.tone} label={before.label} dot />}
        after={<StatusChip tone={after.tone} label={after.label} dot />}
        data-testid="end-comp-preview"
      />
    </ActionDialog>
  );
};
