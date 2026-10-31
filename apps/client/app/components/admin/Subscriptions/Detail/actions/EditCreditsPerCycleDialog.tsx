import React, { useId, useState } from 'react';
import { Checkbox, FormControl, FormHelperText, FormLabel, Input, Stack } from '@mui/joy';
import { useUpdateSubscriptionCredits } from '@client/app/hooks/data/subscriptions';
import { ActionDialog, ADMIN_REASON_PRESETS, ChangePreview, useUndoToast } from '../../../shared';
import { formatCreditDelta, formatCredits } from '../../../Users/Profile/actions/creditAdjustment';
import { ownerDisplayName, undoReason, type SubscriptionDialogProps } from '../subscriptionDetailModel';

/** A positive whole number, thousands separators allowed; `null` for anything else. */
export const parseCreditsPerCycle = (raw: string): number | null => {
  const trimmed = raw.replace(/,/g, '').trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const CREDITS_HINT = 'Enter a whole number of credits above 0.';
const NO_ACTOR_HINT = 'No account can act for this owner.';

/**
 * Edit credits per cycle: sets or clears the admin override. It changes future grants only; undo restores
 * the previous override (or clears it when there was none).
 */
export const EditCreditsPerCycleDialog: React.FC<SubscriptionDialogProps> = ({ detail, onClose, onAudit }) => {
  const inputId = useId();
  const { subscription, credits, actingUserId } = detail;
  const [useDefault, setUseDefault] = useState(false);
  const [raw, setRaw] = useState(String(credits.customPerCycle ?? credits.effectivePerCycle ?? ''));
  const updateCredits = useUpdateSubscriptionCredits();
  const showUndo = useUndoToast();

  const parsed = parseCreditsPerCycle(raw);
  // What the owner gets per cycle once this applies; `null` sends "clear the override".
  const nextOverride = useDefault ? null : parsed;
  const nextEffective = useDefault ? credits.defaultPerCycle : parsed;
  const before = credits.effectivePerCycle;

  const blockedReason = (() => {
    if (actingUserId === null) return NO_ACTOR_HINT;
    if (!useDefault && parsed === null) return CREDITS_HINT;
    // With no override, confirming the plan default would only freeze today's default as an override.
    const unchanged =
      nextOverride === credits.customPerCycle ||
      (credits.customPerCycle === null && nextOverride === credits.defaultPerCycle);
    if (unchanged) return 'That is already the rate for this subscription.';
    return null;
  })();

  const delta = before !== null && nextEffective !== null ? nextEffective - before : null;

  const submit = (creditsPerCycle: number | null, reason: string) => {
    if (actingUserId === null) throw new Error(NO_ACTOR_HINT);
    return updateCredits.mutateAsync({
      userId: actingUserId,
      subscriptionId: subscription.subscriptionId,
      creditsPerCycle,
      reason,
    });
  };

  const handleConfirm = async (reason: string) => {
    const previous = credits.customPerCycle;
    await submit(nextOverride, reason);
    onClose();
    showUndo({
      message:
        nextOverride === null
          ? 'Credits per cycle reset to the plan default'
          : `Credits per cycle set to ${formatCredits(nextOverride)}`,
      onUndo: async () => {
        await submit(previous, undoReason(reason));
      },
      onViewAudit: onAudit,
    });
  };

  const confirmLabel =
    useDefault || nextEffective === null
      ? 'Use plan default'
      : `Set to ${formatCredits(nextEffective)} credits per cycle`;

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Edit credits per cycle"
      description={`${ownerDisplayName(subscription)} gets this many credits at each future renewal. Credits already granted do not change.`}
      reasonPresets={ADMIN_REASON_PRESETS.creditRateChange}
      confirmLabel={confirmLabel}
      blockedReason={blockedReason}
      onConfirm={handleConfirm}
      data-testid="edit-credits-per-cycle-dialog"
    >
      <Stack gap={1}>
        <FormControl disabled={useDefault} error={!useDefault && parsed === null}>
          <FormLabel htmlFor={inputId}>Credits per cycle</FormLabel>
          <Input
            autoFocus
            value={raw}
            onChange={event => setRaw(event.target.value)}
            slotProps={{
              input: {
                id: inputId,
                inputMode: 'numeric',
                autoComplete: 'off',
                'data-testid': 'edit-credits-per-cycle-input',
              },
            }}
            sx={{ fontSize: 16, fontVariantNumeric: 'tabular-nums', minHeight: 40 }}
          />
          <FormHelperText>
            {credits.defaultPerCycle === null
              ? 'The plan default is unknown for this price.'
              : `Plan default: ${formatCredits(credits.defaultPerCycle)}`}
          </FormHelperText>
        </FormControl>
        <Checkbox
          label="Use plan default"
          checked={useDefault}
          onChange={event => setUseDefault(event.target.checked)}
          slotProps={{ input: { 'data-testid': 'edit-credits-per-cycle-default-checkbox' } }}
        />
      </Stack>
      <ChangePreview
        before={before === null ? '-' : formatCredits(before)}
        after={nextEffective === null ? '-' : formatCredits(nextEffective)}
        delta={
          delta === null
            ? undefined
            : { label: formatCreditDelta(delta), tone: delta === 0 ? 'neutral' : delta > 0 ? 'good' : 'bad' }
        }
        data-testid="edit-credits-per-cycle-preview"
      />
    </ActionDialog>
  );
};
