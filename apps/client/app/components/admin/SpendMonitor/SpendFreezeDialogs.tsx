import { useState } from 'react';
import { Alert, FormControl, FormHelperText, FormLabel, Input, Stack, Typography } from '@mui/joy';
import type { SpendFreezeScope, SpendFreezeScopeType } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import { ADMIN_REASON_PRESETS, ActionDialog, ChangePreview, SegmentedControl } from '../shared';
import { FREEZE_SCOPE_OPTIONS, SCOPE_TYPE_LABELS, isObjectId } from './spendMonitorLabels';

const FREEZE_CONSEQUENCE =
  'New metered requests from this account fail until the freeze is lifted. Requests already running finish their current step.';

type FreezeDialogProps = {
  /** Seeds the form, e.g. from an incident row. */
  initialScope?: Partial<SpendFreezeScope>;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onFreeze: (scope: SpendFreezeScope, reason: string) => Promise<void>;
};

/** Mount it only while open: the form state is the dialog's own and resets with each mount. */
export function FreezeSpendDialog({ initialScope, pending, error, onClose, onFreeze }: FreezeDialogProps) {
  const [scopeType, setScopeType] = useState<SpendFreezeScopeType>(initialScope?.scopeType ?? 'User');
  const [scopeId, setScopeId] = useState(initialScope?.scopeId ?? '');
  const trimmedId = scopeId.trim();
  const idMessage = !trimmedId
    ? 'Enter the account ID.'
    : isObjectId(trimmedId)
      ? null
      : 'The ID is 24 characters of 0-9 and a-f.';

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Freeze spending"
      description={FREEZE_CONSEQUENCE}
      reasonPresets={ADMIN_REASON_PRESETS.spendFreeze}
      confirmLabel="Freeze spending"
      blockedReason={idMessage}
      pending={pending}
      onConfirm={reason => onFreeze({ scopeType, scopeId: trimmedId }, reason)}
      data-testid="spend-monitor-freeze-dialog"
    >
      <Stack gap={2}>
        <SegmentedControl
          options={FREEZE_SCOPE_OPTIONS}
          value={scopeType}
          onChange={setScopeType}
          aria-label="Account type"
          data-testid="spend-monitor-freeze-scope-type"
        />
        <FormControl error={!!trimmedId && !!idMessage}>
          <FormLabel>{SCOPE_TYPE_LABELS[scopeType]} ID</FormLabel>
          <Input
            value={scopeId}
            onChange={event => setScopeId(event.target.value)}
            placeholder="24-character ID"
            slotProps={{ input: { 'data-testid': 'spend-monitor-freeze-scope-id', spellCheck: false } }}
            sx={{ fontFamily: 'code' }}
          />
          {!!trimmedId && idMessage && (
            <FormHelperText data-testid="spend-monitor-freeze-scope-id-error">{idMessage}</FormHelperText>
          )}
        </FormControl>
        <ChangePreview before="Allowed" after="Paused" data-testid="spend-monitor-freeze-preview" />
        {!!error && (
          <Alert color="danger" data-testid="spend-monitor-freeze-error">
            {getErrorMessage(error)}
          </Alert>
        )}
      </Stack>
    </ActionDialog>
  );
}

type LiftDialogProps = {
  scope: SpendFreezeScope;
  label: string | null;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onLift: (reason: string) => Promise<void>;
};

export function LiftSpendFreezeDialog({ scope, label, pending, error, onClose, onLift }: LiftDialogProps) {
  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Lift freeze"
      description="Metered requests from this account work again right away."
      reasonPresets={ADMIN_REASON_PRESETS.spendFreezeLift}
      confirmLabel="Lift freeze"
      pending={pending}
      onConfirm={onLift}
      data-testid="spend-monitor-lift-dialog"
    >
      <Stack gap={2}>
        <Stack gap={0.25}>
          <Typography level="body-sm" sx={{ color: 'admin.ink' }}>
            {label ?? scope.scopeId}
          </Typography>
          <Typography level="body-xs" fontFamily="code" sx={{ color: 'admin.inkMuted' }}>
            {SCOPE_TYPE_LABELS[scope.scopeType]} {scope.scopeId}
          </Typography>
        </Stack>
        <ChangePreview before="Paused" after="Allowed" data-testid="spend-monitor-lift-preview" />
        {!!error && (
          <Alert color="danger" data-testid="spend-monitor-lift-error">
            {getErrorMessage(error)}
          </Alert>
        )}
      </Stack>
    </ActionDialog>
  );
}
