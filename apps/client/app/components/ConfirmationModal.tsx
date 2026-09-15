import { Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog, Typography } from '@mui/joy';
import { useConfirmationModal } from '../hooks/useConfirmation';
import WarningIcon from '@mui/icons-material/Warning';
import { useState } from 'react';

const ConfirmationModal = () => {
  const {
    open,
    type,
    title,
    description: content,
    okLabel = 'Ok',
    cancelLabel = 'Cancel',
    onOk,
  } = useConfirmationModal();
  const [loading, setLoading] = useState(false);
  const setConfirmationModal = useConfirmationModal.setState;

  async function handleOk() {
    setLoading(true);
    try {
      await onOk();
    } catch (e) {
      console.log('An Error has occured on confirmation', e);
    }

    setLoading(false);
    setConfirmationModal({ open: false });
  }

  return (
    <Modal className="confirmation-modal" open={open}>
      <ModalDialog className="confirmation-modal-dialog" data-testid="confirmation-modal" sx={{ boxShadow: 'none' }}>
        <DialogTitle className="confirmation-modal-title">
          {type === 'danger' && <WarningIcon className="confirmation-modal-warning-icon" />}
          {title}
        </DialogTitle>
        <DialogContent className="confirmation-modal-content">
          <Typography className="confirmation-modal-message">{content}</Typography>
        </DialogContent>
        <DialogActions
          className="confirmation-modal-actions"
          sx={{ flexDirection: 'row', justifyContent: 'flex-end', flexGrow: 0 }}
        >
          <Button
            className="confirmation-modal-cancel-button"
            variant="outlined"
            color="neutral"
            onClick={() => setConfirmationModal({ open: false })}
            disabled={loading}
            sx={{
              borderRadius: '6px',
              border: '1px solid',
              borderColor: 'border.solid',
            }}
          >
            {cancelLabel}
          </Button>

          <Button
            className="confirmation-modal-confirm-button"
            data-testid="confirmation-modal-confirm-btn"
            color={type === 'danger' ? 'danger' : 'primary'}
            onClick={handleOk}
            disabled={loading}
            sx={{ borderRadius: '6px' }}
          >
            {okLabel}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default ConfirmationModal;
