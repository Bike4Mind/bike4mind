import React, { useState } from 'react';
import { useAdminSubscriptionCancel, useAdminSubscriptionResume } from '@client/app/hooks/data/adminSubscriptionDetail';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, undoAdminReason, useUndoToast } from '../../../shared';
import { formatDate, ownerDisplayName, type SubscriptionDialogProps } from '../subscriptionDetailModel';

/**
 * Cancel at period end: the customer keeps access and credits until the period ends, and nothing is refunded.
 * The idempotency key is minted once per open, so a retry after a failure repeats the same Stripe write.
 * Undo is a fresh resume (its own key and audit entry), not a rollback of this one.
 */
export const CancelSubscriptionDialog: React.FC<SubscriptionDialogProps> = ({ detail, onClose, onAudit }) => {
  const { subscription } = detail;
  const cancel = useAdminSubscriptionCancel(subscription.id);
  const resume = useAdminSubscriptionResume(subscription.id);
  const showUndo = useUndoToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const name = ownerDisplayName(subscription);
  const endDate = formatDate(subscription.periodEndsAt) ?? 'the end of the period';

  const handleConfirm = async (reason: string) => {
    const { stripe } = await cancel.mutateAsync({
      reason,
      idempotencyKey,
      expectedState: detail.stripe?.stateToken ?? '',
    });
    onClose();
    showUndo({
      message: `Cancellation scheduled for ${name}`,
      onUndo: async () => {
        await resume.mutateAsync({
          reason: undoAdminReason(reason),
          idempotencyKey: crypto.randomUUID(),
          expectedState: stripe.stateToken,
        });
      },
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Cancel subscription"
      description={`Cancels at the end of the period on ${endDate}. They keep access and credits until then. No refund.`}
      reasonPresets={ADMIN_REASON_PRESETS.subscriptionCancel}
      confirmLabel="Cancel at period end"
      tone="danger"
      onConfirm={handleConfirm}
      data-testid="cancel-subscription-dialog"
    >
      <ChangePreview
        before={`Renews ${endDate}`}
        after={`Cancels ${endDate}`}
        data-testid="cancel-subscription-preview"
      />
    </ActionDialog>
  );
};
