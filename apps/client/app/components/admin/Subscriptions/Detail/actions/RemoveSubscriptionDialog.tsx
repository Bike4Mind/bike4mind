import React from 'react';
import { useRemoveSubscription } from '@client/app/hooks/data/subscriptions';
import { ActionDialog, ADMIN_REASON_PRESETS } from '../../../shared';
import {
  ownerDisplayName,
  subscriptionActionAvailability,
  type SubscriptionDialogProps,
} from '../subscriptionDetailModel';

type RemoveSubscriptionDialogProps = Omit<SubscriptionDialogProps, 'onAudit'> & { onRemoved: () => void };

/**
 * Remove subscription: deletes our record outright, so it is only offered for comps and ended rows (a live
 * Stripe row would keep billing). Irreversible, hence the typed confirm and no undo.
 */
export const RemoveSubscriptionDialog: React.FC<RemoveSubscriptionDialogProps> = ({ detail, onClose, onRemoved }) => {
  const { subscription, actingUserId } = detail;
  const remove = useRemoveSubscription();
  const name = ownerDisplayName(subscription);
  const blockedReason = subscriptionActionAvailability(detail).remove.disabledReason;

  const handleConfirm = async (reason: string) => {
    if (actingUserId === null) return;
    await remove.mutateAsync({ userId: actingUserId, subscriptionId: subscription.subscriptionId, reason });
    onClose();
    onRemoved();
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Remove subscription"
      description={`Deletes this subscription record for ${name}. This cannot be undone.`}
      reasonPresets={ADMIN_REASON_PRESETS.subscriptionRemove}
      confirmLabel="Remove subscription record"
      tone="danger"
      blockedReason={blockedReason}
      // ActionDialog trims what the admin types, so a stored name with stray whitespace must be trimmed too.
      typedConfirm={{ expected: name.trim(), noun: 'owner name' }}
      onConfirm={handleConfirm}
      data-testid="remove-subscription-dialog"
    />
  );
};
