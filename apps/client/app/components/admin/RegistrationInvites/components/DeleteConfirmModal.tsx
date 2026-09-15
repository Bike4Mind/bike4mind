import React from 'react';
import { Box, Button, Modal, ModalClose, Sheet, Typography } from '@mui/joy';
import { useRegistrationInvitesStore } from '../store';

interface DeleteConfirmModalProps {
  onConfirm: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ onConfirm }) => {
  const { openDeleteWarning, setOpenDeleteWarning, multiSelected } = useRegistrationInvitesStore();

  const handleConfirm = () => {
    onConfirm();
    setOpenDeleteWarning(false);
  };

  const handleClose = () => {
    setOpenDeleteWarning(false);
  };

  return (
    <Modal
      open={openDeleteWarning}
      onClose={handleClose}
      sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}
    >
      <Sheet
        sx={{
          width: '560px',
          boxShadow: 'lg',
          borderRadius: '8px',
          padding: '0px',
        }}
      >
        <ModalClose />
        <Box textAlign={'center'} mt={'4em'} mb={'2em'}>
          <Typography mt={'30px'} mb={'20px'} level={'body-md'}>
            Are you sure you want to delete {multiSelected.length} selected registration invite
            {multiSelected.length !== 1 ? 's' : ''}?
          </Typography>

          <Button sx={{ mr: '1em' }} color={'success'} onClick={handleConfirm}>
            Confirm
          </Button>
          <Button color={'danger'} onClick={handleClose}>
            Cancel
          </Button>
        </Box>
      </Sheet>
    </Modal>
  );
};
