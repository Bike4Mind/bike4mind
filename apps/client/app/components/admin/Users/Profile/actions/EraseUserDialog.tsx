import React, { useState } from 'react';
import { CircularProgress, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { AdminErasureCollection, AdminErasurePreview, AdminErasureState } from '@bike4mind/common';
import { ActionDialog, ADMIN_REASON_PRESETS, DataTable, formatUtc, type DataColumn } from '../../../shared';
import { displayName } from '../userProfileModel';
import type { ProfileDialogProps } from './profileActions';
import { useAdminErasureState, usePreviewAdminErasure, useRequestAdminErasure } from './useAdminErasure';

const pendingMessage = (state: AdminErasureState): string | null => {
  if (state.state === 'selfDeletionPending') {
    return `This user scheduled their own account deletion for ${formatUtc(new Date(state.scheduledFor))}.`;
  }
  if (state.state === 'requested') {
    const started = state.purgeStartedAt ? ` Removal started ${formatUtc(new Date(state.purgeStartedAt))}.` : '';
    return `An erasure was requested ${formatUtc(new Date(state.requestedAt))}.${started}`;
  }
  return null;
};

const SCOPE_COLUMNS: readonly DataColumn<AdminErasureCollection>[] = [
  { id: 'model', label: 'Collection', render: row => row.model },
  { id: 'deleted', label: 'Deleted', numeric: true, render: row => row.deleted },
  { id: 'anonymized', label: 'Removed from', numeric: true, render: row => row.anonymized },
  { id: 'retained', label: 'Kept', numeric: true, render: row => row.retained },
  { id: 'why', label: 'Why kept', render: row => row.retainReasons.join('; ') },
];

const ScopeTable: React.FC<{ collections: readonly AdminErasureCollection[] }> = ({ collections }) => (
  <DataTable
    rows={collections}
    columns={SCOPE_COLUMNS}
    getRowId={row => row.model}
    label="Erasure dry run"
    // The rows are already loaded: there is nothing to retry.
    onRetry={() => undefined}
    empty={<Typography level="body-sm">No stored records name this user.</Typography>}
    pagination={false}
    maxHeight="280px"
    testId="erase-user-scope-table"
    rowTestId={() => 'erase-user-scope-row'}
  />
);

/**
 * Data subject erasure in two audited steps: a dry run of what the data holder registry says an
 * erasure does, then the irreversible request, which locks the account and purges it at once. The
 * person is not emailed.
 */
export const EraseUserDialog: React.FC<ProfileDialogProps> = ({ user, onClose }) => {
  const state = useAdminErasureState(user.id);
  const preview = usePreviewAdminErasure(user.id);
  const request = useRequestAdminErasure(user.id);
  const [scope, setScope] = useState<AdminErasurePreview | null>(null);
  const name = displayName(user);

  if (!scope) {
    const blocked = state.data ? pendingMessage(state.data) : null;
    return (
      <ActionDialog
        key="preview"
        open
        onClose={onClose}
        title={`Erase data of ${name}`}
        description="First, a dry run: counts per collection of the records an erasure deletes, removes this person from, and keeps (with the reason). Nothing changes yet."
        reasonPresets={ADMIN_REASON_PRESETS.dataSubjectErasure}
        confirmLabel="Run dry run"
        pending={preview.isPending}
        blockedReason={state.isPending ? 'Checking for a pending deletion.' : blocked}
        onConfirm={async reason => setScope(await preview.mutateAsync(reason))}
        data-testid="erase-user-preview-dialog"
      >
        {state.isPending && <CircularProgress size="sm" />}
        {blocked && (
          <Typography level="body-sm" data-testid="erase-user-pending">
            {blocked}
          </Typography>
        )}
      </ActionDialog>
    );
  }

  const handleConfirm = async (reason: string) => {
    const { queued } = await request.mutateAsync(reason);
    onClose();
    toast.success(
      queued
        ? 'Erasure started. The account is locked and its data is being removed.'
        : 'The account is locked. Its data is removed by the next daily deletion run.'
    );
  };

  return (
    // A fresh form: the irreversible step takes its own reason, not the dry run's.
    <ActionDialog
      key="erase"
      open
      onClose={onClose}
      title={`Erase data of ${name}`}
      description="Locks the account and permanently deletes it and its data now, with no grace period and no email to the person. Records kept for a stated reason stay. There is no undo."
      reasonPresets={ADMIN_REASON_PRESETS.dataSubjectErasure}
      typedConfirm={
        user.email ? { expected: user.email, noun: 'email address' } : { expected: user.id, noun: 'user ID' }
      }
      confirmLabel="Erase user data permanently"
      tone="danger"
      pending={request.isPending}
      onConfirm={handleConfirm}
      data-testid="erase-user-dialog"
    >
      <Stack spacing={1}>
        <Typography level="title-sm">Dry run, {formatUtc(new Date(scope.generatedAt))}</Typography>
        <ScopeTable collections={scope.collections} />
      </Stack>
    </ActionDialog>
  );
};
