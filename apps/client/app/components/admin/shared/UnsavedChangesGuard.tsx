import { useBlocker } from '@tanstack/react-router';
import { Button, Modal, ModalDialog, Stack, Typography } from '@mui/joy';

export function SettingsWarningDialog({
  open,
  warnings,
  onClose,
  onSave,
}: {
  open: boolean;
  warnings: string[];
  onClose(): void;
  onSave(): void;
}) {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog data-testid="admin-settings-warning-dialog">
        <Typography level="title-md">Review settings changes</Typography>
        {warnings.map(warning => (
          <Typography key={warning}>{warning}</Typography>
        ))}
        <Stack direction="row" gap={1} justifyContent="flex-end">
          <Button variant="plain" onClick={onClose} data-testid="admin-settings-warning-cancel-btn">
            Keep editing
          </Button>
          <Button onClick={onSave} data-testid="admin-settings-warning-save-btn">
            Save changes
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

export function UnsavedChangesGuard({
  dirty,
  pending,
  isLeaving,
}: {
  dirty: boolean;
  pending?: boolean;
  isLeaving(current: { pathname: string; search: object }, next: { pathname: string; search: object }): boolean;
}) {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirty && isLeaving(current, next),
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  return (
    <Modal open={blocker.status === 'blocked'} onClose={() => blocker.reset?.()}>
      <ModalDialog data-testid="admin-unsaved-dialog">
        <Typography level="title-md">Discard unsaved changes?</Typography>
        <Typography>Leaving discards your unsaved edits. Keep editing to save them first.</Typography>
        <Stack direction="row" gap={1} justifyContent="flex-end">
          <Button variant="plain" onClick={() => blocker.reset?.()} data-testid="admin-unsaved-cancel-btn">
            Keep editing
          </Button>
          <Button
            color="danger"
            disabled={pending}
            onClick={() => blocker.proceed?.()}
            data-testid="admin-unsaved-discard-btn"
          >
            Discard changes
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}
