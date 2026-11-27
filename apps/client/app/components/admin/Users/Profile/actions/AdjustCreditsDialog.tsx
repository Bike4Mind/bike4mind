import React, { useId, useState } from 'react';
import { FormControl, FormLabel, Input } from '@mui/joy';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  ChangePreview,
  CreditGrantNotice,
  isCreditGrantLimitError,
  planCreditGrant,
  planTypedConfirm,
  SegmentedControl,
  undoAdminReason,
  useUndoToast,
} from '../../../shared';
import { RecentCreditGrants } from '../../../shared/RecentCreditGrants';
import { useAdminRecentCreditGrants } from '@client/app/hooks/data/adminUserCredits';
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
import { useAdminUserUpdate, type AdminUserUpdate } from './useAdminUserUpdate';
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
  const recentGrants = useAdminRecentCreditGrants(user.id);

  const amount = parseCreditAmount(rawAmount);
  const adjustment = amount === null ? null : computeCreditAdjustment(balance, mode, amount);
  const modeConfig = CREDIT_ADJUSTMENT_MODES.find(entry => entry.mode === mode) ?? CREDIT_ADJUSTMENT_MODES[0];
  const granted = Math.max(0, adjustment?.delta ?? 0);
  const plan = planCreditGrant(granted, recentGrants.data);
  const typedConfirm = planTypedConfirm(plan);

  const blockedReason = refreshFailed
    ? BALANCE_REFRESH_FAILED
    : adjustment === null
      ? CREDIT_AMOUNT_HINT
      : adjustment.delta === 0
        ? `The balance is already ${formatCredits(balance)}.`
        : plan.kind === 'over_limit'
          ? plan.notice
          : null;

  const changeMode = (next: CreditAdjustmentMode) => {
    setMode(next);
    setRawAmount(next === 'set' ? String(Math.max(balance, 0)) : '0');
  };

  const submit = async (payload: AdminUserUpdate, reason: string) => {
    let result: unknown;
    try {
      result = await update({ ...payload, creditReason: reason });
    } catch (error) {
      if (isCreditGrantLimitError(error)) void recentGrants.refetch();
      throw error;
    }
    onClose();
    // A grant held for approval comes back pending, with nothing applied to undo.
    if (!result || typeof result !== 'object' || !('appliedCreditDelta' in result)) return;
    const delta = result.appliedCreditDelta;
    if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || delta === 0) return;
    const after =
      'currentCredits' in result && typeof result.currentCredits === 'number' ? result.currentCredits : null;
    showUndo({
      message:
        after === null
          ? `Credits adjusted (${formatCreditDelta(delta)})`
          : `Balance set to ${formatCredits(after)} (${formatCreditDelta(delta)})`,
      onUndo: () => update({ creditDelta: -delta, creditReason: undoAdminReason(reason) }),
      onViewAudit: onAudit,
    });
  };

  const handleConfirm = async (reason: string) => {
    if (amount === null || !adjustment) return;
    const confirmed = typedConfirm ? { confirmLargeGrant: true } : {};
    await submit({ ...creditAdjustmentPayload(mode, amount), ...confirmed }, reason);
  };

  // Sent as an added amount whatever the mode, since the server never splits the larger grant itself.
  const grantNow =
    (plan.kind === 'approval' || plan.kind === 'over_limit') && plan.grantNow > 0
      ? {
          label: `Grant ${formatCredits(plan.grantNow)} now`,
          onConfirm: (reason: string) =>
            submit(
              { creditDelta: plan.grantNow, ...(plan.grantNowNeedsPhrase ? { confirmLargeGrant: true } : {}) },
              reason
            ),
          ignoreBlockedReason: plan.kind === 'over_limit',
          skipTypedConfirm: !plan.grantNowNeedsPhrase,
        }
      : undefined;

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Adjust credits"
      description={`${displayName(user)} \u00b7 current balance ${formatCredits(balance)}`}
      reasonPresets={ADMIN_REASON_PRESETS.creditAdjustment}
      confirmLabel={
        plan.kind === 'approval'
          ? 'Submit for approval'
          : adjustment && adjustment.delta !== 0
            ? `Set balance to ${formatCredits(adjustment.after)}`
            : 'Apply'
      }
      blockedReason={blockedReason}
      typedConfirm={typedConfirm}
      secondaryAction={grantNow}
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
      <CreditGrantNotice credits={granted} plan={plan} data-testid="adjust-credits-grant-value" />
      <RecentCreditGrants userId={user.id} data-testid="adjust-credits-recent-grants" />
    </ActionDialog>
  );
};
