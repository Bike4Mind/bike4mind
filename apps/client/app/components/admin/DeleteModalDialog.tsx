import React from 'react';
import { IModalDocument } from '@bike4mind/common';
import { ActionDialog } from './shared';
import { ADMIN_REASON_PRESETS } from './shared/adminReason';

type DeleteModalDialogProps = {
  modal: IModalDocument | null;
  onClose: () => void;
  /** The caller closes the dialog once the delete succeeds; on failure it stays open for a retry. */
  onDelete: () => Promise<void>;
  pending?: boolean;
  'data-testid': string;
  confirmTestId: string;
};

/** Typed-title delete confirmation shared by the Modals and What's new tabs. */
export function DeleteModalDialog({
  modal,
  onClose,
  onDelete,
  pending,
  'data-testid': testId,
  confirmTestId,
}: DeleteModalDialogProps) {
  const title = modal?.title?.replace(/\s+/g, ' ').trim();
  return (
    <ActionDialog
      open={!!modal}
      onClose={onClose}
      title="Delete modal"
      description={`"${title || 'Untitled modal'}" is removed for every user. This cannot be undone.`}
      reasonPresets={ADMIN_REASON_PRESETS.modalDelete}
      // DELETE /api/modals/[id]/delete logs the deletion but takes no reason.
      reasonAudited={false}
      typedConfirm={{ expected: title || 'delete', noun: title ? 'modal title' : 'word delete' }}
      confirmLabel="Delete modal"
      tone="danger"
      pending={pending}
      onConfirm={onDelete}
      data-testid={testId}
      testIds={{ confirm: confirmTestId }}
    />
  );
}
