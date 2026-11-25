import React from 'react';
import { Button, Typography } from '@mui/joy';
import { AdminDialog, AdminDialogFooter } from '@client/app/components/admin/shared/AdminDialog';
import { useRegistrationInvitesStore } from '../store';

interface DeleteConfirmModalProps {
  onConfirm: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ onConfirm }) => {
  const { openDeleteWarning, setOpenDeleteWarning, multiSelected } = useRegistrationInvitesStore();
  const count = multiSelected.length;
  const noun = count === 1 ? 'invite' : 'invites';

  const handleConfirm = () => {
    onConfirm();
    setOpenDeleteWarning(false);
  };

  const handleClose = () => {
    setOpenDeleteWarning(false);
  };

  return (
    <AdminDialog
      open={openDeleteWarning}
      onClose={handleClose}
      title="Delete invites"
      role="alertdialog"
      data-testid="delete-invites-modal"
    >
      <Typography level="body-md">
        Are you sure you want to delete {count} selected registration {noun}?
      </Typography>
      <AdminDialogFooter>
        <Button variant="plain" color="neutral" onClick={handleClose} data-testid="delete-invites-cancel-btn">
          Cancel
        </Button>
        <Button
          variant="solid"
          color="danger"
          disabled={count === 0}
          onClick={handleConfirm}
          data-testid="delete-invites-confirm-btn"
        >
          Delete {count} {noun}
        </Button>
      </AdminDialogFooter>
    </AdminDialog>
  );
};
