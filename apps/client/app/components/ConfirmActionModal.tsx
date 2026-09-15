import { Box, Button, CircularProgress, DialogContent, DialogTitle, Modal, ModalDialog, Typography } from '@mui/joy';
import React from 'react';

export interface ConfirmActionModalProps {
  className?: string;
  title: string;
  description: string;
  // Function to execute when the "Go Forward" button is clicked
  onGoForward: (id: string | undefined) => void;
  // Function to execute when the "Go Backward" button is clicked
  onGoBackward: () => void;
  // ID to pass when executing the "Go Forward" function
  itemId?: string | undefined;
  // Text and styling for buttons
  open?: boolean;
  forwardButtonText?: string;
  backwardButtonText?: string;
  disabledConfirm?: boolean;
  loading?: boolean;
  ['data-testid']?: string;
}

const ConfirmActionModal: React.FC<ConfirmActionModalProps> = ({
  title,
  description,
  onGoForward,
  onGoBackward,
  itemId,
  open = true,
  forwardButtonText = 'Confirm',
  backwardButtonText = 'Cancel',
  disabledConfirm = false,
  loading = false,
  'data-testid': testId = '',
}) => {
  return (
    <Modal open={open} onClose={() => !loading && onGoBackward()}>
      <ModalDialog data-testid={testId} sx={{ boxShadow: 'none', maxWidth: '400px', gap: '16px' }}>
        <DialogTitle sx={{ color: 'text.primary' }}>{title}</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: '24px' }}>
          <Typography sx={{ color: 'text.tertiary' }}>{description}</Typography>

          <Box sx={{ display: 'flex', gap: '1rem', justifyContent: 'end' }}>
            <Button
              data-testid="confirm-modal-cancel-btn"
              variant="outlined"
              color="neutral"
              onClick={onGoBackward}
              sx={{
                borderRadius: '6px',
                border: '1px solid',
                borderColor: 'border.solid',
                fontWeight: 500,
              }}
            >
              {backwardButtonText}
            </Button>
            <Button
              data-testid="confirm-modal-confirm-btn"
              color="danger"
              onClick={() => onGoForward(itemId)}
              disabled={disabledConfirm || loading}
              sx={{ borderRadius: '6px' }}
            >
              {loading ? <CircularProgress /> : forwardButtonText}
            </Button>
          </Box>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default ConfirmActionModal;
