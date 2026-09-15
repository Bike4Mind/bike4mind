import React from 'react';
import { Modal, ModalDialog, Box } from '@mui/joy';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { MobileTopBar } from '@client/app/components/MobileTopBar';
import AgentsSection from './AgentsSection';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

interface AgentsModalProps {
  open: boolean;
  onClose: () => void;
}

const AgentsModal: React.FC<AgentsModalProps> = ({ open, onClose }) => {
  const isMobile = useIsMobile();

  return (
    <Modal
      open={open}
      onClose={onClose}
      disableScrollLock={false}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 0,
      }}
    >
      <ModalDialog
        sx={{
          width: '100vw',
          height: '100dvh',
          maxWidth: '100vw',
          maxHeight: 'none',
          borderRadius: 0,
          margin: 0,
          border: 0,
          p: 0,
          overflow: 'hidden',
        }}
      >
        {/* Mobile Header */}
        {isMobile && <MobileTopBar title="Agents" onClose={onClose} />}

        <Box
          sx={{
            px: 1,
            height: 'calc(100dvh - 56px)',
            overflow: 'auto',
            ...scrollbarStyles,
          }}
        >
          <AgentsSection />
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default AgentsModal;
