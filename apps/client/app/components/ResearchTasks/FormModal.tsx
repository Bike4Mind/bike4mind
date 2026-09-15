import { Modal, ModalClose, ModalDialog, Box, useTheme } from '@mui/joy';
import { FC } from 'react';
import { whiteAlpha, blackAlpha, grayAlpha, brand, blue, purple, gray } from '../../utils/themes/colors';
import ResearchTaskForm from './Form';

interface FormModalProps {
  open: boolean;
  onClose: () => void;
  onTaskCreated?: (taskId: string) => void;
  taskId?: string;
  researchAgentId: string;
}

const ResearchTaskFormModal: FC<FormModalProps> = ({ open, onClose, onTaskCreated, taskId, researchAgentId }) => {
  const theme = useTheme();
  const mode = theme.palette.mode;

  const handleFormSubmit = (createdTaskId?: string) => {
    if (createdTaskId && !taskId) {
      onTaskCreated?.(createdTaskId);
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      sx={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        backdropFilter: 'blur(4px)',
        padding: 2,
      }}
    >
      <ModalDialog
        sx={{
          width: '90vw',
          maxWidth: '1600px',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          margin: 'auto',
          background:
            mode === 'dark'
              ? `linear-gradient(135deg, ${gray[850]} 0%, ${gray[900]} 100%)`
              : `linear-gradient(135deg, ${whiteAlpha[0][95]} 0%, ${grayAlpha[15][95]} 100%)`,
          boxShadow: `0 25px 50px -12px ${blackAlpha[0][25]}`,
          borderRadius: '16px',
          border: `1px solid ${mode === 'dark' ? grayAlpha[700][50] : whiteAlpha[0][20]}`,
          position: 'relative',
          overflow: 'hidden',
          transform: 'none',
          top: 'auto',
          left: 'auto',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '4px',
            background: `linear-gradient(135deg, ${blue[400]} 0%, ${brand[500]} 50%, ${purple[500]} 100%)`,
          },
        }}
      >
        <ModalClose
          sx={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 10,
            borderRadius: '50%',
            transition: 'all 0.2s ease',
            '&:hover': {
              bgcolor: 'danger.softHoverBg',
              transform: 'scale(1.1)',
            },
          }}
        />

        <Box
          sx={{
            p: 3,
            pt: 2,
            overflowY: 'auto',
            flex: 1,
            '&::-webkit-scrollbar': {
              width: '8px',
            },
            '&::-webkit-scrollbar-track': {
              background: 'transparent',
            },
            '&::-webkit-scrollbar-thumb': {
              background: blackAlpha[0][20],
              borderRadius: '4px',
            },
            '&::-webkit-scrollbar-thumb:hover': {
              background: blackAlpha[0][30],
            },
          }}
        >
          <ResearchTaskForm
            taskId={taskId}
            researchAgentId={researchAgentId}
            onSubmit={handleFormSubmit}
            onCancel={onClose}
          />
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default ResearchTaskFormModal;
