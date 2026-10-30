import React, { useState } from 'react';
import { FormControl, FormLabel } from '@mui/joy';
import { COMP_MAX_MONTHS_AHEAD } from '@client/app/utils/adminSubscriptionDetail';
import { useAdminSubscriptionCompChange } from '@client/app/hooks/data/adminSubscriptionDetail';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, SegmentedControl, useUndoToast } from '../../../shared';
import {
  addMonths,
  compExtensionBase,
  formatDate,
  ownerDisplayName,
  undoReason,
  type SubscriptionDialogProps,
} from '../subscriptionDetailModel';

const EXTEND_OPTIONS = [
  { value: '1', label: '1 month' },
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
] as const;

type ExtendMonths = (typeof EXTEND_OPTIONS)[number]['value'];

/**
 * Extend comp: moves the end date out by whole months from the later of today and the current end. A comp
 * holds no Stripe state, so this only changes our record; undo restores the previous end date.
 */
export const ExtendCompDialog: React.FC<SubscriptionDialogProps> = ({ detail, onClose, onAudit }) => {
  const { subscription } = detail;
  const [now] = useState(Date.now);
  const [months, setMonths] = useState<ExtendMonths>('1');
  const change = useAdminSubscriptionCompChange(subscription.id);
  const showUndo = useUndoToast();

  const previousEndsAt = subscription.periodEndsAt && new Date(subscription.periodEndsAt).toISOString();
  const target = addMonths(compExtensionBase(subscription, now), Number(months));
  const targetLabel = formatDate(target) ?? '-';
  const tooFar = target.getTime() > addMonths(new Date(now), COMP_MAX_MONTHS_AHEAD).getTime();

  const handleConfirm = async (reason: string) => {
    await change.mutateAsync({ action: 'setEndsAt', periodEndsAt: target.toISOString(), reason });
    onClose();
    showUndo({
      message: `Comp extended to ${targetLabel}`,
      onUndo: async () => {
        if (!previousEndsAt) return;
        await change.mutateAsync({ action: 'setEndsAt', periodEndsAt: previousEndsAt, reason: undoReason(reason) });
      },
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Extend comp"
      description={`${ownerDisplayName(subscription)} keeps the plan until the new end date. No credits are added by this change.`}
      reasonPresets={ADMIN_REASON_PRESETS.compChange}
      confirmLabel={`Extend to ${targetLabel}`}
      blockedReason={tooFar ? `A comp can end at most ${COMP_MAX_MONTHS_AHEAD} months from today.` : null}
      onConfirm={handleConfirm}
      data-testid="extend-comp-dialog"
    >
      <FormControl>
        <FormLabel>Extend by</FormLabel>
        <SegmentedControl
          options={EXTEND_OPTIONS}
          value={months}
          onChange={setMonths}
          aria-label="Extend by"
          data-testid="extend-comp-months"
        />
      </FormControl>
      <ChangePreview
        before={formatDate(subscription.periodEndsAt) ?? '-'}
        after={targetLabel}
        data-testid="extend-comp-preview"
      />
    </ActionDialog>
  );
};
