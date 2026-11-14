import { useDialogRequestScope } from '../useDialogRequestScope';
import { useState, type ReactNode } from 'react';
import { Alert, Button, Checkbox, Stack, Typography } from '@mui/joy';
import { useMutation } from '@tanstack/react-query';
import type { AdminModelAccess, ModelAccessChange, ModelAccessPatchResult } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import {
  apiErrorOf,
  conflictEntryOf,
  patchModelAccess,
  useInvalidateModelAccess,
} from '@client/app/hooks/data/adminModels';
import { ADMIN_REASON_PRESETS, ActionDialog, ChangePreview, undoAdminReason, useUndoToast } from '../../shared';
import { useModelsNavigation } from '../modelsNavigation';
import {
  applyAccessChange,
  changedFields,
  describeAccess,
  effectiveAccess,
  inverseAccessChange,
  isAdminsOnly,
} from './modelAccessChange';

export const MODEL_PICKER_FRESHNESS = 'Open pickers update within about 15 seconds.';

export type ModelAccessTarget = { id: string; name: string; access: Pick<AdminModelAccess, 'entry'> };

type Props = {
  /** Null while closed. */
  target: ModelAccessTarget | null;
  /** Null while an editor in `children` has no change yet. */
  change: ModelAccessChange | null;
  title: string;
  confirmLabel: string;
  onClose: () => void;
  onDone?: (result: ModelAccessPatchResult) => void;
  /** Open the audit entry in a new tab instead of in place. Set where leaving the page would unmount the Undo toast. */
  auditInNewTab?: boolean;
  /** An editor shown above the preview; it builds `change`. */
  children?: ReactNode;
};

/**
 * One model's access write (PATCH /api/admin/models/access): before/after preview, required reason, the
 * admins-only confirm, the stale-entry 409 and an Undo toast that writes the inverse change.
 */
export function ModelAccessDialog({
  target,
  change,
  title,
  confirmLabel,
  onClose,
  onDone,
  auditInNewTab = false,
  children,
}: Props) {
  const captureRequest = useDialogRequestScope(target?.id ?? 'closed');
  const invalidate = useInvalidateModelAccess();
  const showUndo = useUndoToast();
  const { openModel, modelHref } = useModelsNavigation();
  const [adminOnlyConfirmed, setAdminOnlyConfirmed] = useState(false);
  const [serverAskedAdminOnly, setServerAskedAdminOnly] = useState(false);

  const write = useMutation({
    mutationFn: ({ reason }: { reason: string }) => {
      if (!target || !change) throw new Error('No change to save');
      return patchModelAccess(target.id, target.access.entry, {
        change,
        reason,
        ...(adminOnlyConfirmed ? { confirmAdminOnly: true } : {}),
      });
    },
  });

  if (!target) return null;

  const before = effectiveAccess(target.access.entry);
  const after = change ? applyAccessChange(before, change) : before;
  const fields = change ? changedFields(change) : [];
  const needsAdminOnlyConfirm = (!!change && isAdminsOnly(after)) || serverAskedAdminOnly;
  const conflict = conflictEntryOf(write.error) !== undefined;
  const failure = apiErrorOf(write.error);

  const close = () => {
    if (write.isPending) return;
    write.reset();
    setAdminOnlyConfirmed(false);
    setServerAskedAdminOnly(false);
    onClose();
  };

  const confirm = async (reason: string) => {
    const isCurrent = captureRequest();
    if (!change) return;
    let result: ModelAccessPatchResult;
    try {
      result = await write.mutateAsync({ reason });
    } catch (error) {
      if (!isCurrent()) return;
      const { status, data } = apiErrorOf(error);
      if (status === 422 && Array.isArray(data.adminOnlyIds)) setServerAskedAdminOnly(true);
      return;
    }
    await invalidate();
    if (!isCurrent()) return;
    const name = target.name;
    if (!result.changed) {
      showUndo({ message: `Nothing changed: ${name} already had this access.` });
    } else {
      const undo = inverseAccessChange(before, change);
      showUndo({
        message: `${confirmLabel}: ${name}. ${MODEL_PICKER_FRESHNESS}`,
        onUndo: async () => {
          await patchModelAccess(target.id, result.entry, {
            change: undo,
            reason: undoAdminReason(reason),
            confirmAdminOnly: true,
          });
          await invalidate();
        },
        ...(auditInNewTab
          ? { auditHref: modelHref(target.id, 'admin') }
          : { onViewAudit: () => void openModel(target.id, 'admin') }),
      });
    }
    onDone?.(result);
    close();
  };

  return (
    <ActionDialog
      open
      onClose={close}
      title={title}
      description={`${target.name} (${target.id})`}
      reasonPresets={ADMIN_REASON_PRESETS.modelAccess}
      confirmLabel={confirmLabel}
      onConfirm={confirm}
      pending={write.isPending}
      blockedReason={
        !change
          ? 'Change something first.'
          : conflict
            ? 'Reload to see the current access first.'
            : needsAdminOnlyConfirm && !adminOnlyConfirmed
              ? 'Confirm that only admins will see this model.'
              : null
      }
      data-testid="model-access-dialog"
    >
      <Stack gap={1.5}>
        {children}
        {change && (
          <ChangePreview
            before={describeAccess(before, fields).join('; ')}
            after={describeAccess(after, fields).join('; ')}
            data-testid="model-access-preview"
          />
        )}
        <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
          {MODEL_PICKER_FRESHNESS}
        </Typography>
        {needsAdminOnlyConfirm && (
          <Alert color="danger" variant="soft" data-testid="model-access-admin-only">
            <Stack gap={1}>
              <Typography level="body-sm">
                Only admins will see this model: it has no tags and no entitlements, so no user can pick it.
              </Typography>
              <Checkbox
                size="sm"
                label="Keep it visible to admins only"
                checked={adminOnlyConfirmed}
                onChange={event => setAdminOnlyConfirmed(event.target.checked)}
                slotProps={{ input: { 'data-testid': 'model-access-admin-only-checkbox' } }}
              />
            </Stack>
          </Alert>
        )}
        {conflict ? (
          <Alert
            color="warning"
            data-testid="model-access-conflict"
            endDecorator={
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                data-testid="model-access-reload-btn"
                onClick={() => {
                  write.reset();
                  void invalidate().then(close);
                }}
              >
                Reload
              </Button>
            }
          >
            {typeof failure.data.error === 'string' ? failure.data.error : getErrorMessage(write.error)}
          </Alert>
        ) : (
          write.error &&
          !(failure.status === 422 && serverAskedAdminOnly) && (
            <Alert color="danger" data-testid="model-access-error">
              {getErrorMessage(write.error)}
            </Alert>
          )
        )}
      </Stack>
    </ActionDialog>
  );
}

/** Turns one model on or off. Pass the row as it was when the dialog opened, so a refetch cannot flip the verb. */
export function ModelToggleDialog({ model, onClose }: { model: ModelAccessTarget; onClose: () => void }) {
  const { enabled } = effectiveAccess(model.access.entry);
  const verb = enabled ? 'Turn off' : 'Turn on';
  return (
    <ModelAccessDialog
      target={model}
      change={{ enabled: !enabled }}
      title={`${verb} ${model.name}`}
      confirmLabel={verb}
      onClose={onClose}
    />
  );
}
