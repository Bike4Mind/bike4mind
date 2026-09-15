import { FC, ReactNode } from 'react';
import { Modal, ModalDialog, Typography, Button, Box } from '@mui/joy';
import { createPortal } from 'react-dom';
import WarningRoundedIcon from '@mui/icons-material/WarningRounded';
import { toast } from 'sonner';

export interface ConfirmationModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Callback when modal should close */
  onClose: () => void;
  /** Callback when user confirms the action */
  onConfirm: () => void | Promise<void>;
  /** Whether the confirm action is in progress (shows loading state) */
  loading?: boolean;
  /** Title of the modal */
  title?: string;
  /** Description text */
  description?: string | ReactNode;
  /** Text for the confirm button */
  confirmText?: string;
  /** Text for the cancel button */
  cancelText?: string;
  /** Color variant for the confirm button */
  confirmColor?: 'danger' | 'primary' | 'neutral';
  /** Icon to display in the header */
  icon?: ReactNode;
  /** Maximum width of the modal */
  maxWidth?: number | string;
  /** Whether to show the warning icon */
  showWarningIcon?: boolean;
  /** Success message to show after confirmation */
  successMessage?: string;
  /** Error message to show if confirmation fails */
  errorMessage?: string;
  /** Whether to show toast notifications */
  showToast?: boolean;
}

/** Reusable confirmation modal. Rendered through a portal to avoid z-index issues. */
const ConfirmationModal: FC<ConfirmationModalProps> = ({
  open,
  onClose,
  onConfirm,
  loading = false,
  title = 'Confirm Action',
  description = 'Are you sure you want to proceed? This action cannot be undone.',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmColor = 'danger',
  icon,
  maxWidth = 400,
  showWarningIcon = false,
  successMessage,
  errorMessage,
  showToast = false,
}) => {
  const handleConfirm = async () => {
    try {
      await onConfirm();
      if (showToast && successMessage) {
        toast.success(successMessage);
      }
    } catch (error) {
      if (showToast && errorMessage) {
        toast.error(errorMessage);
      }
      throw error; // Re-throw to let parent handle the error
    }
  };

  const handleCancel = () => {
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  const handleModalClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  if (!open) return null;

  return createPortal(
    <Modal open={open} onClose={onClose} onClick={handleBackdropClick}>
      <ModalDialog
        data-testid="confirmation-dialog"
        variant="outlined"
        role="alertdialog"
        sx={{
          maxWidth,
          gap: 0,
          border: 'none',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.1)',
        }}
        onClick={handleModalClick}
      >
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          {showWarningIcon && (
            <WarningRoundedIcon
              sx={{
                fontSize: '20px',
                color: 'danger.500',
                flexShrink: 0,
              }}
            />
          )}
          {icon}
          <Typography
            component="h2"
            color={confirmColor}
            sx={{
              fontSize: '18px',
              fontWeight: 500,
              flex: 1,
            }}
          >
            {title}
          </Typography>
        </Box>

        {/* Description */}
        <Typography
          sx={{
            mb: 3,
            color: 'text.tertiary',
            lineHeight: 1.5,
          }}
        >
          {description}
        </Typography>

        {/* Actions */}
        <Box
          sx={{
            display: 'flex',
            gap: 1,
            justifyContent: 'flex-end',
            pt: 1,
          }}
        >
          <Button
            data-testid="confirmation-cancel-btn"
            variant="plain"
            color="neutral"
            onClick={handleCancel}
            disabled={loading}
            sx={{ minWidth: 80 }}
          >
            {cancelText}
          </Button>
          <Button
            data-testid="confirmation-confirm-btn"
            variant="solid"
            color={confirmColor}
            onClick={handleConfirm}
            loading={loading}
            sx={{ minWidth: 80 }}
          >
            {confirmText}
          </Button>
        </Box>
      </ModalDialog>
    </Modal>,
    document.body
  );
};

export default ConfirmationModal;
