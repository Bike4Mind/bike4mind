import React, { useId } from 'react';
import { DialogTitle, Modal, ModalClose, ModalDialog, dialogContentClasses } from '@mui/joy';
import { adminFocusScope } from './adminStyles';

export type AdminDialogProps = {
  open?: boolean;
  onClose: () => void;
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
        <ModalClose data-testid={`${testId}-close-btn`} />
        <DialogTitle id={titleId} component="h2">
          {title}
        </DialogTitle>
        {children}
      </ModalDialog>
    </Modal>
  );
}
