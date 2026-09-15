import React, { useEffect, useState } from 'react';
import { Modal, ModalDialog, Box, Typography, IconButton } from '@mui/joy';
import { ModalListRenderer } from './ModalListRenderer';
import CloseIcon from '@mui/icons-material/Close';
import { keyframes } from '@mui/system';
import { useGetPresignedUrl } from '@client/app/hooks/data/fabFiles';

// Slide in animation
const slideIn = keyframes`
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
`;

// Fade in animation
const fadeIn = keyframes`
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
`;

interface ModalListPopupProps {
  open: boolean;
  onClose: () => void;
  modals: any[];
  message?: string;
}

export const ModalListPopup: React.FC<ModalListPopupProps> = ({ open, onClose, modals, message }) => {
  const [processedModals, setProcessedModals] = useState<any[]>(modals);
  const { mutateAsync: getPresignedUrl } = useGetPresignedUrl();

  // Sync state immediately when modals prop changes
  useEffect(() => {
    setProcessedModals(modals);
  }, [modals]);

  // Process modal images to get presigned URLs
  useEffect(() => {
    const processModalImages = async () => {
      if (!modals || modals.length === 0) {
        setProcessedModals([]);
        return;
      }

      const processed = await Promise.all(
        modals.map(async modal => {
          if (modal.imageUrl) {
            try {
              const urlObj = new URL(modal.imageUrl);
              const filePath = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
              const [presignedUrl] = await getPresignedUrl({ filePaths: [filePath], expiresIn: 3600 });
              return { ...modal, imageUrl: presignedUrl };
            } catch (e) {
              console.log('[ModalListPopup] Error getting presigned URL:', e);
              return modal; // Return original if error
            }
          }
          return modal;
        })
      );

      setProcessedModals(processed);
    };

    if (open) {
      processModalImages();
    }
  }, [modals, open, getPresignedUrl]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: open ? `${fadeIn} 0.3s ease` : undefined,
      }}
    >
      <ModalDialog
        variant="outlined"
        sx={{
          maxWidth: '90vw',
          width: '1200px',
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          p: 0,
          borderRadius: 'xl',
          boxShadow: 'xl',
          bgcolor: 'background.surface',
          border: '1px solid',
          borderColor: 'divider',
          animation: open ? `${slideIn} 0.4s ease` : undefined,
        }}
      >
        {/* Header */}
        <Box
          sx={{
            p: 3,
            pb: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.level1',
          }}
        >
          <Typography
            level="title-lg"
            sx={{
              color: 'text.primary',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              gap: 1,
            }}
          >
            ✨ Modal Gallery
          </Typography>
          <IconButton
            onClick={onClose}
            variant="outlined"
            size="sm"
            sx={{
              '&:hover': {
                bgcolor: 'background.level2',
              },
            }}
          >
            <CloseIcon />
          </IconButton>
        </Box>

        {/* Content */}
        <Box
          sx={{
            flex: 1,
            overflow: 'auto',
            overflowX: 'hidden', // Prevent horizontal scroll
            p: 3,
            bgcolor: 'background.surface',
            '&::-webkit-scrollbar': {
              width: '8px',
            },
            '&::-webkit-scrollbar-track': {
              bgcolor: 'background.level1',
              borderRadius: 'sm',
            },
            '&::-webkit-scrollbar-thumb': {
              bgcolor: 'primary.300',
              borderRadius: 'sm',
              '&:hover': {
                bgcolor: 'primary.400',
              },
            },
          }}
        >
          <ModalListRenderer modals={processedModals} message={message} />
        </Box>

        {/* Footer */}
        <Box
          sx={{
            p: 2,
            borderTop: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.level1',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
            {processedModals.length} {processedModals.length === 1 ? 'modal' : 'modals'} • Click cards to expand preview
          </Typography>
        </Box>
      </ModalDialog>
    </Modal>
  );
};
