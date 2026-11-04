import React, { useState } from 'react';
import { useAdminSubscriptionResume } from '@client/app/hooks/data/adminSubscriptionDetail';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, useUndoToast } from '../../../shared';
import { formatDate, ownerDisplayName, type SubscriptionDialogProps } from '../subscriptionDetailModel';

/** Resume: clears the scheduled cancellation so the subscription renews as normal. */
export const ResumeSubscriptionDialog: React.FC<SubscriptionDialogProps> = ({ detail, onClose, onAudit }) => {
  const { subscription } = detail;
  const resume = useAdminSubscriptionResume(subscription.id);
  const showUndo = useUndoToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const name = ownerDisplayName(subscription);
  // A schedule can be a custom cancel date set in Stripe, which differs from the period end.
  const cancelDate = formatDate(subscription.cancelAt ?? subscription.periodEndsAt) ?? 'the end of the period';
  const renewDate = formatDate(subscription.periodEndsAt) ?? 'the end of the period';

  const handleConfirm = async (reason: string) => {
    await resume.mutateAsync({ reason, idempotencyKey, expectedState: detail.stripe?.stateToken ?? '' });
    onClose();
    showUndo({ message: `Subscription resumed for ${name}`, onViewAudit: onAudit });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Resume subscription"
      description={`Removes the scheduled cancellation, so it renews after ${renewDate} as normal.`}
      reasonPresets={ADMIN_REASON_PRESETS.subscriptionResume}
      confirmLabel="Resume subscription"
      onConfirm={handleConfirm}
      data-testid="resume-subscription-dialog"
    >
      <ChangePreview
        before={`Cancels ${cancelDate}`}
        after={`Renews ${renewDate}`}
        data-testid="resume-subscription-preview"
      />
    </ActionDialog>
  );
};
