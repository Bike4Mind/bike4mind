import React, { FC } from 'react';
import { Modal, ModalDialog, DialogContent, Button, Stack, Typography, IconButton, Box } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import { IModal } from '@bike4mind/common';

interface GenericModalProps extends IModal {
  presignedUrl?: string;
  hasPresignedUrl?: boolean;
  isOpen: boolean;
  onClose: () => void;
  onAgree: () => void;
  isPreview?: boolean;
}

const GenericModal: FC<GenericModalProps> = ({
  title,
  subtitle,
  description,
  closeButton,
  agreeButton,
  isOpen,
  onClose,
  onAgree,
  isPreview = false,
  isBanner,
  imageUrl,
  textMessage,
  images,
  presignedUrl,
  hasPresignedUrl,
}) => {
  const renderCloseButton = () =>
    closeButton && (
      <IconButton
        onClick={onClose}
        sx={{
          position: 'absolute',
          right: 8,
          top: 8,
          bgcolor: 'background.surface',
          '&:hover': { bgcolor: 'background.level1' },
        }}
        data-testid="generic-modal-close-button-icon-container"
      >
        <CloseIcon data-testid="generic-modal-close-button-icon" />
      </IconButton>
    );

  const renderAgreeButton = () => {
    if (agreeButton) {
      return (
        <Button
          onClick={onAgree}
          sx={{
            mt: 2,
            fontWeight: 'bold',
            boxShadow: 'md',
            '&:hover': { transform: 'translateY(-2px)', boxShadow: 'lg' },
          }}
        >
          Heard!
        </Button>
      );
    }
  };

  const renderContent = () => {
    // Banner: Mobile notification style (title + textMessage only)
    if (isBanner) {
      return (
        <Stack spacing={2} sx={{ width: '100%' }}>
          {title && (
            <Typography level="h4" sx={{ fontWeight: 'bold' }}>
              {title}
            </Typography>
          )}
          {textMessage && (
            <Typography level="body-md" sx={{ color: 'text.primary' }}>
              {textMessage}
            </Typography>
          )}
          {((hasPresignedUrl && presignedUrl) || (imageUrl && hasPresignedUrl === undefined)) && (
            <Box
              component="img"
              src={hasPresignedUrl && presignedUrl ? presignedUrl : String(imageUrl)}
              alt="Banner image"
              sx={{ width: '100%', borderRadius: 'md', objectFit: 'cover', maxHeight: '150px' }}
            />
          )}
        </Stack>
      );
    }

    // Modal: Rich content display (title + subtitle + description)
    return (
      <Stack spacing={2} sx={{ width: '100%' }}>
        {title && (
          <Typography level="h2" sx={{ textAlign: 'center', fontWeight: 'bold' }}>
            {title}
          </Typography>
        )}
        {subtitle && (
          <Typography level="h4" sx={{ textAlign: 'center', color: 'text.secondary' }}>
            {subtitle}
          </Typography>
        )}
        {((hasPresignedUrl && presignedUrl) || (imageUrl && hasPresignedUrl === undefined)) && (
          <Box
            component="img"
            src={hasPresignedUrl && presignedUrl ? presignedUrl : imageUrl || ''}
            alt="Modal imagez"
            sx={{ width: '100%', borderRadius: 'md', objectFit: 'cover' }}
          />
        )}
        {images && images.length > 0 && renderImages()}

        {description && (
          <Box sx={{ maxHeight: '60vh', overflowY: 'auto', p: 2, bgcolor: 'background.level1', borderRadius: 'md' }}>
            <MarkdownViewer content={description} />
          </Box>
        )}
      </Stack>
    );
  };

  const renderImages = () => (
    <Stack spacing={2}>
      {images?.map((image, index) => (
        <Box
          key={index}
          component="img"
          src={image.url}
          alt={`Modal image ${index + 1}`}
          sx={{
            width: image.width ? `${image.width}px` : '100%',
            height: image.height ? `${image.height}px` : 'auto',
            borderRadius: 'md',
            objectFit: 'cover',
            border: '1px solid',
            borderColor: 'divider',
            alignSelf: 'center',
          }}
        />
      ))}
    </Stack>
  );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1999,
      }}
    >
      <ModalDialog
        sx={{
          maxWidth: 600,
          width: '90%',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: 'lg',
          borderRadius: 'md',
          ...(isBanner && {
            position: 'fixed',
            bottom: 16,
            maxWidth: '100%',
            m: 0,
          }),
        }}
      >
        <DialogContent sx={{ position: 'relative', p: 3 }}>
          {renderCloseButton()}
          {renderContent()}
          <Stack direction="row" justifyContent="center" sx={{ mt: 3 }}>
            {renderAgreeButton()}
          </Stack>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default GenericModal;
