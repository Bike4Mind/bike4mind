import React, { useId } from 'react';
import { DialogTitle, Modal, ModalClose, ModalDialog, Stack, dialogContentClasses } from '@mui/joy';
import { adminFocusScope } from './adminStyles';

export type AdminDialogProps = {
  open?: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
  title: string;
  children: React.ReactNode;
  /** Max width in px; the dialog never exceeds the viewport minus a 16 px gutter each side. */
  width?: number;
  /** `alertdialog` for a confirm that interrupts, such as a delete. */
  role?: 'dialog' | 'alertdialog';
  /** Also derives `<id>-close-btn`. */
  'data-testid': string;
};

/**
 * The admin modal shell: Joy's focus trap, Esc to close, focus return, a close button and an h2
 * title. Audited writes use ActionDialog, which is built on this; unaudited dialogs use it directly.
 */
export function AdminDialog({
  open = true,
  onClose,
  closeDisabled = false,
  title,
  children,
  width = 440,
  role = 'dialog',
  'data-testid': testId,
}: AdminDialogProps) {
  const titleId = useId();
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        role={role}
        aria-labelledby={titleId}
        data-testid={testId}
        sx={{
          ...adminFocusScope,
          width: `min(${width}px, calc(100vw - 32px))`,
          overflowY: 'auto',
          // The dialog scrolls as a whole; a nested scroll box in DialogContent clips focus rings.
          [`& .${dialogContentClasses.root}`]: { overflow: 'visible' },
        }}
      >
        <ModalClose disabled={closeDisabled} data-testid={`${testId}-close-btn`} />
        <DialogTitle id={titleId} component="h2">
          {title}
        </DialogTitle>
        {children}
      </ModalDialog>
    </Modal>
  );
}

/** The button row under a dialog's content, the commit button last. ActionDialog's footer is this row. */
export function AdminDialogFooter({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="flex-end"
      gap={1}
      flexWrap="wrap"
      sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
    >
      {children}
    </Stack>
  );
}
