import React, { useId, useState } from 'react';
import { FormControl, FormLabel, Input } from '@mui/joy';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, SegmentedControl, useUndoToast } from '../../../shared';
import {
  CREDIT_ADJUSTMENT_MODES,
  CREDIT_AMOUNT_HINT,
  computeCreditAdjustment,
  creditAdjustmentPayload,
  formatCreditDelta,
  formatCredits,
  parseCreditAmount,
  type CreditAdjustmentMode,
} from './creditAdjustment';
import { useAdminUserUpdate } from './useAdminUserUpdate';
import { BALANCE_REFRESH_FAILED, useRefreshedUser } from './useRefreshedUser';
import type { ProfileDialogProps } from './profileActions';
import { displayName } from '../userProfileModel';

/**
 * Adjust credits (DESIGN_GUIDE.md section 4, "changes money"): Set to, Add or Subtract with a
 * before -> after preview, and 0 is a valid target. Undo sends the opposite delta rather than the old
 * absolute balance, so spend that landed in between is never refunded.
 */
export const AdjustCreditsDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const amountId = useId();
  const { refreshing, failed: refreshFailed } = useRefreshedUser(user.id);
  const balance = user.currentCredits ?? 0;
  const [mode, setMode] = useState<CreditAdjustmentMode>('set');
  const [rawAmount, setRawAmount] = useState('0');
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();

  const amount = parseCreditAmount(rawAmount);
  const adjustment = amount === null ? null : computeCreditAdjustment(balance, mode, amount);
  const modeConfig = CREDIT_ADJUSTMENT_MODES.find(entry => entry.mode === mode) ?? CREDIT_ADJUSTMENT_MODES[0];

  const blockedReason = refreshFailed
    ? BALANCE_REFRESH_FAILED
    : adjustment === null
      ? CREDIT_AMOUNT_HINT
      : adjustment.delta === 0
        ? `The balance is already ${formatCredits(balance)}.`
        : null;

  const changeMode = (next: CreditAdjustmentMode) => {
    setMode(next);
    setRawAmount(next === 'set' ? String(Math.max(balance, 0)) : '0');
  };

  const handleConfirm = async (reason: string) => {
    if (amount === null || !adjustment) return;
    await update({ ...creditAdjustmentPayload(mode, amount), creditReason: reason });
    onClose();
    const { delta, after } = adjustment;
    showUndo({
      message: `Balance set to ${formatCredits(after)} (${formatCreditDelta(delta)})`,
      onUndo: () => update({ creditDelta: -delta, creditReason: `Undo: ${reason}`.slice(0, 500) }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Adjust credits"
      description={`${displayName(user)} \u00b7 current balance ${formatCredits(balance)}`}
      reasonPresets={ADMIN_REASON_PRESETS.creditAdjustment}
      confirmLabel={
        adjustment && adjustment.delta !== 0 ? `Set balance to ${formatCredits(adjustment.after)}` : 'Apply'
      }
      blockedReason={blockedReason}
      pending={refreshing}
      onConfirm={handleConfirm}
      data-testid="adjust-credits-dialog"
    >
      <SegmentedControl
        options={CREDIT_ADJUSTMENT_MODES.map(({ mode: value, label }) => ({ value, label }))}
        value={mode}
        onChange={changeMode}
        aria-label="Adjustment type"
        data-testid="adjust-credits-mode"
      />
      <FormControl>
        <FormLabel htmlFor={amountId}>{modeConfig.amountLabel}</FormLabel>
        <Input
          autoFocus
          value={rawAmount}
          onChange={event => setRawAmount(event.target.value)}
          error={amount === null}
          slotProps={{
            input: {
              id: amountId,
              inputMode: 'numeric',
              autoComplete: 'off',
              'data-testid': 'adjust-credits-amount-input',
            },
          }}
          sx={{ fontSize: 16, fontVariantNumeric: 'tabular-nums', minHeight: 40 }}
        />
      </FormControl>
      <ChangePreview
        before={formatCredits(balance)}
        after={adjustment ? formatCredits(adjustment.after) : '-'}
        delta={
          adjustment
            ? {
                label: formatCreditDelta(adjustment.delta),
                tone: adjustment.delta === 0 ? 'neutral' : adjustment.delta > 0 ? 'good' : 'bad',
              }
            : undefined
        }
        data-testid="adjust-credits-preview"
      />
    </ActionDialog>
  );
};
