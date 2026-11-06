import { Skeleton, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';
import { ActionDialog } from '../../shared/ActionDialog';
import { ADMIN_REASON_PRESETS, undoAdminReason } from '../../shared/adminReason';
import { pendingNoopCopy } from '../../shared/PendingCredits';
import { useUndoToast } from '../../shared/UndoToast';
import {
  usePendingBulkPreview,
  usePendingBulkRun,
  usePendingBulkUndo,
  type PendingBulkKind,
  type PendingBulkOutcome,
} from './usePendingBulkActions';

const plural = (count: number) => `${count.toLocaleString()} account${count === 1 ? '' : 's'}`;

const COPY: Readonly<
  Record<
    PendingBulkKind,
    { label: string; done: string; description: string; presets: readonly string[]; audited: boolean }
  >
> = {
  release: {
    label: 'Release held grants for',
    done: 'Released held grants for',
    description: 'Pays each held signup grant now, outside the daily pool. Undo takes the credits back.',
    presets: ADMIN_REASON_PRESETS.signupGrantRelease,
    // The release route records the batch in its audit entries, not a typed reason.
    audited: false,
  },
  block: {
    label: 'Block signup grants for',
    done: 'Blocked signup grants for',
    description: 'Stops further signup credits and pauses queued rewards. Credits already paid stay paid.',
    presets: ADMIN_REASON_PRESETS.signupGrantBlock,
    audited: true,
  },
};

export function PendingBulkDialog({
  kind,
  userIds,
  onClose,
  onDone,
}: {
  kind: PendingBulkKind;
  userIds: readonly string[];
  onClose: () => void;
  onDone: (outcome: PendingBulkOutcome) => void;
}) {
  const copy = COPY[kind];
  const preview = usePendingBulkPreview(kind, userIds);
  const run = usePendingBulkRun();
  const undo = usePendingBulkUndo();
  const showUndoToast = useUndoToast();
  const wouldApply = preview.data?.wouldApply ?? 0;

  const blockedReason = preview.isError
    ? 'The dry run failed. Close and try again.'
    : !preview.data
      ? 'Counting the accounts this changes\u2026'
      : wouldApply === 0
        ? 'None of the selected accounts would change.'
        : null;

  const onConfirm = async (reason: string) => {
    try {
      const outcome = await run.mutateAsync({ kind, userIds, reason });
      onDone(outcome);
      onClose();
      if (outcome.failedIds.length > 0) toast.warning(`${plural(outcome.failedIds.length)} could not be changed.`);
      const pendingUndo = outcome.undo;
      if (!pendingUndo) {
        toast.info('No accounts were changed.');
        return;
      }
      showUndoToast({
        message: `${copy.done} ${plural(outcome.applied)}`,
        onUndo: async () => {
          const restored = await undo.mutateAsync({
            undo: pendingUndo,
            reason: undoAdminReason(reason),
            affectedIds: outcome.appliedIds,
          });
          if (restored.insufficientBalance > 0)
            toast.warning(
              `${plural(restored.insufficientBalance)} already spent the credits, so they were not taken back.`
            );
          if (restored.failed > 0) toast.warning(`${plural(restored.failed)} could not be restored.`);
          if (restored.restored > 0) toast.success(`Restored ${plural(restored.restored)}`);
        },
      });
    } catch (error) {
      toast.error(`${copy.label} the selected accounts failed: ${getErrorMessage(error)}`);
    }
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`${copy.label} ${preview.data ? plural(wouldApply) : 'accounts'}`}
      description={copy.description}
      reasonPresets={copy.presets}
      reasonAudited={copy.audited}
      confirmLabel={`${kind === 'release' ? 'Release' : 'Block'} ${plural(wouldApply)}`}
      onConfirm={onConfirm}
      tone={kind === 'block' ? 'danger' : 'neutral'}
      blockedReason={blockedReason}
      pending={run.isPending}
      data-testid={`pending-bulk-${kind}`}
    >
      {preview.data ? (
        <Stack gap={0.5} data-testid="pending-bulk-preview">
          <Typography level="body-sm" data-testid="pending-bulk-would-apply">
            {plural(wouldApply)} of {userIds.length.toLocaleString()} selected would change.
          </Typography>
          {preview.data.noops.map(({ reason, count }) => (
            <Typography
              key={reason}
              level="body-xs"
              sx={{ color: 'text.secondary' }}
              data-testid={`pending-bulk-noop-${reason}`}
            >
              {plural(count)}: {pendingNoopCopy(reason)}
            </Typography>
          ))}
        </Stack>
      ) : (
        !preview.isError && (
          <Skeleton
            variant="text"
            level="body-sm"
            width="60%"
            role="status"
            aria-busy="true"
            aria-label="Counting the accounts this changes"
            data-testid="pending-bulk-counting"
          />
        )
      )}
    </ActionDialog>
  );
}
