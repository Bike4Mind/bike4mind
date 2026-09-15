import React from 'react';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Typography from '@mui/joy/Typography';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import { purple, cyan, whiteAlpha, grayAlpha, blackAlpha } from '@client/app/utils/themes/colors';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  loading = false,
  onConfirm,
  onCancel,
}) => {
  return (
    <Modal open={open} onClose={onCancel} sx={{ zIndex: 14001 }}>
      <ModalDialog
        sx={{
          minWidth: 340,
          zIndex: 14001,
          background: `linear-gradient(135deg, ${whiteAlpha[0][98]} 0%, ${grayAlpha[15][95]} 50%, ${grayAlpha[5][98]} 100%)`,
          boxShadow: `0 25px 50px -12px ${blackAlpha[0][30]}, 0 0 0 1px ${whiteAlpha[0][5]}`,
          borderRadius: '20px',
          border: `1px solid ${whiteAlpha[0][30]}`,
          overflow: 'hidden',
          backdropFilter: 'blur(20px)',
        }}
      >
        <Typography level="h4" mb={2}>
          {title}
        </Typography>
        <Typography mb={2}>{description}</Typography>
        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button variant="plain" color="neutral" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant="solid"
            color="danger"
            loading={loading}
            onClick={onConfirm}
            sx={{
              background: `linear-gradient(135deg, ${purple[300]} 0%, ${cyan[400]} 100%)`,
              borderRadius: '12px',
              px: 2,
              py: 1,
              fontWeight: 600,
            }}
          >
            {confirmLabel}
          </Button>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default ConfirmModal;
